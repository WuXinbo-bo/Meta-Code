const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { BackendRecoveryPolicy } = require("./backend-recovery.cjs");

const PRODUCT_NAME = "Meta Code";
const PRODUCT_ID = "meta-code";
const START_TIMEOUT_MS = 60_000;
const TEST_HEADLESS = process.env.METACODE_DESKTOP_HEADLESS === "1";
const dataHome = path.resolve(process.env.METACODE_HOME || path.join(os.homedir(), ".metacode"));
const desktopDir = path.join(dataHome, "desktop");
const logDir = path.join(dataHome, "logs");
const runtimeStateFile = path.join(desktopDir, "runtime.json");
const windowStateFile = path.join(desktopDir, "window.json");
const launcherToken = crypto.randomBytes(32).toString("hex");
const apiToken = crypto.randomBytes(32).toString("base64url");

app.setPath("userData", path.join(desktopDir, "electron"));

let mainWindow = null;
let backend = null;
let backendPort = 0;
let backendLog = null;
let allowQuit = false;
let quitStarted = false;
let recoveryInFlight = false;
const recoveryPolicy = new BackendRecoveryPolicy();

function runtimeRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "workbench") : path.resolve(__dirname, "..");
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, file);
}

function rotateLog(file) {
  try {
    if (fs.statSync(file).size < 4 * 1024 * 1024) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
  } catch { /* A new log is created below. */ }
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1_500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode === 200 && value.ok && value.productId === PRODUCT_ID) resolve(value);
          else reject(new Error("后端健康检查返回了其他服务"));
        } catch { reject(new Error("后端健康检查响应无效")); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("health timeout")));
    request.once("error", reject);
  });
}

async function waitForBackend(processHandle, port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    if (processHandle.exitCode !== null) throw new Error(`后端提前退出（${processHandle.exitCode ?? "unknown"}）`);
    try { return await health(port); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error("后端启动超时，请查看工作台日志");
}

async function startBackend() {
  const root = runtimeRoot();
  const entry = path.join(root, "dist-server", "index.js");
  const frontend = path.join(root, "dist", "index.html");
  if (!fs.existsSync(entry) || !fs.existsSync(frontend)) throw new Error("桌面运行时不完整，请重新安装 Meta Code");
  await fsp.mkdir(logDir, { recursive: true });
  rotateLog(path.join(logDir, "desktop-backend.log"));
  backendPort = await allocatePort();
  backendLog?.end();
  const processLog = fs.createWriteStream(path.join(logDir, "desktop-backend.log"), { flags: "a", mode: 0o600 });
  backendLog = processLog;
  const processHandle = spawn(process.execPath, [entry], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      METACODE_APP_VERSION: app.getVersion(),
      PORT: String(backendPort),
      METACODE_HOME: dataHome,
      METACODE_DESKTOP: "1",
      WORKBENCH_PACKAGED: "1",
      METACODE_LAUNCHER_TOKEN: launcherToken,
      METACODE_API_TOKEN: apiToken
    }
  });
  backend = processHandle;
  processHandle.stdout.pipe(processLog, { end: false });
  processHandle.stderr.pipe(processLog, { end: false });
  processHandle.once("exit", (code, signal) => {
    processLog.write(`\n[launcher] backend exited: code=${code} signal=${signal}\n`);
    processLog.end();
    if (backendLog === processLog) backendLog = null;
    if (backend === processHandle) backend = null;
    if (!quitStarted && !recoveryInFlight && mainWindow && !mainWindow.isDestroyed()) void recoverBackend(new Error("Meta Code 后端意外退出"));
  });
  const status = await waitForBackend(processHandle, backendPort);
  await writeJsonAtomic(runtimeStateFile, {
    schemaVersion: 1,
    productId: PRODUCT_ID,
    version: status.version,
    launcherPid: process.pid,
    backendPid: processHandle.pid,
    port: backendPort,
    startedAt: new Date().toISOString(),
    runtimeRoot: root
  });
  return status;
}

function loadingHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{height:100%;margin:0;background:#fff;color:#171918;font-family:"Segoe UI",sans-serif}body{display:grid;place-items:center}.loading{display:grid;justify-items:center;gap:14px}.mark{display:grid;width:48px;height:48px;place-items:center;border:1px solid #d7d9d7;border-radius:10px;font-size:11px;font-weight:700}.copy{display:grid;gap:4px;text-align:center}.copy strong{font-size:15px}.copy span{color:#777d79;font-size:11px}.line{width:120px;height:2px;overflow:hidden;background:#eceeed}.line:after{display:block;width:38%;height:100%;background:#252927;content:"";animation:load 1.8s ease-in-out infinite}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(365%)}}</style></head><body><div class="loading"><div class="mark">MC</div><div class="copy"><strong>Meta Code</strong><span id="status">正在启动工作台</span></div><div class="line"></div></div></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function recoveryHtml(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{height:100%;margin:0;background:#fff;color:#171918;font-family:"Segoe UI",sans-serif}body{display:grid;place-items:center}.recovery{display:grid;width:min(420px,calc(100vw - 48px));gap:14px}.mark{display:grid;width:48px;height:48px;place-items:center;border:1px solid #d7d9d7;border-radius:10px;font-size:11px;font-weight:700}.copy{display:grid;gap:6px}.copy strong{font-size:17px}.copy span{color:#686e6a;font-size:12px;line-height:1.6}.actions{display:flex;gap:8px;flex-wrap:wrap}button{min-height:34px;padding:0 12px;border:1px solid #d5d9d6;border-radius:6px;background:#fff;color:#343936;cursor:pointer}button.primary{border-color:#252927;background:#252927;color:#fff}</style></head><body><main class="recovery"><div class="mark">MC</div><div class="copy"><strong>工作台服务暂时不可用</strong><span>${escapeHtml(message)}</span></div><div class="actions"><button class="primary" onclick="location.href='metacode-recovery://retry'">重新连接</button><button onclick="location.href='metacode-recovery://logs'">打开日志</button><button onclick="location.href='metacode-recovery://quit'">退出</button></div></main></body></html>`;
}

function createWindow() {
  const saved = readJson(windowStateFile, {});
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: Number(saved.width) || 1440,
    height: Number(saved.height) || 900,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    icon: path.join(runtimeRoot(), "public", "workbench.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const target = new URL(details.url);
      if (target.hostname === "127.0.0.1" && Number(target.port) === backendPort) details.requestHeaders["X-MetaCode-Api-Token"] = apiToken;
    } catch { /* Non-HTTP application resources do not need the local API token. */ }
    callback({ requestHeaders: details.requestHeaders });
  });
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  mainWindow.once("ready-to-show", () => { if (!TEST_HEADLESS) mainWindow?.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${backendPort}/`) || url.startsWith("data:text/html")) return;
    event.preventDefault();
    if (url.startsWith("metacode-recovery://retry")) void retryBackendRecovery();
    else if (url.startsWith("metacode-recovery://logs")) void shell.openPath(logDir);
    else if (url.startsWith("metacode-recovery://quit")) app.quit();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  mainWindow.on("close", () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    const bounds = mainWindow.getBounds();
    void writeJsonAtomic(windowStateFile, bounds).catch(() => undefined);
  });
  return mainWindow;
}

async function showFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryHtml(message))}`).catch(() => undefined);
    if (!TEST_HEADLESS) mainWindow.show();
  }
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.appendFile(path.join(logDir, "desktop-launcher.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  if (!TEST_HEADLESS && !mainWindow) void dialog.showErrorBox("Meta Code 启动失败", `${message}\n\n日志：${logDir}`);
}

async function showRecovering(attempt) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  await mainWindow.webContents.executeJavaScript(`document.getElementById("status").textContent=${JSON.stringify(`正在恢复工作台服务（第 ${attempt} 次）`)}`).catch(() => undefined);
  if (!TEST_HEADLESS) mainWindow.show();
}

async function showRestoreProgress(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  await mainWindow.webContents.executeJavaScript(`document.getElementById("status").textContent=${JSON.stringify(message)}`).catch(() => undefined);
  if (!TEST_HEADLESS) mainWindow.show();
}

async function discardFailedBackend() {
  const failed = backend;
  backend = null;
  const failedLog = backendLog;
  backendLog = null;
  if (failed && failed.exitCode === null) failed.kill();
  if (!failed) failedLog?.end();
}

async function recoverBackend(cause) {
  if (recoveryInFlight || quitStarted) return;
  recoveryInFlight = true;
  let lastError = cause;
  try {
    while (recoveryPolicy.recordAttempt()) {
      const attempt = 2 - recoveryPolicy.remaining();
      await showRecovering(attempt);
      await discardFailedBackend();
      try {
        await startBackend();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
        return;
      } catch (error) {
        lastError = error;
        await fsp.appendFile(path.join(logDir, "desktop-launcher.log"), `${new Date().toISOString()} recovery failed: ${error instanceof Error ? error.message : String(error)}\n`, "utf8");
        await discardFailedBackend();
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    await showFailure(new Error(`${lastError instanceof Error ? lastError.message : String(lastError)}。自动恢复已停止，可手动重试或打开日志。`));
  } finally {
    recoveryInFlight = false;
  }
}

async function retryBackendRecovery() {
  recoveryPolicy.reset();
  await recoverBackend(new Error("正在按用户请求重新连接"));
}

async function requestBackendShutdown() {
  if (!backendPort) return;
  await new Promise((resolve) => {
    const request = http.request({ hostname: "127.0.0.1", port: backendPort, path: "/api/internal/launcher/shutdown", method: "POST", timeout: 1_500, headers: { "x-metacode-launcher-token": launcherToken } }, (response) => { response.resume(); response.on("end", resolve); });
    request.once("timeout", () => { request.destroy(); resolve(); });
    request.once("error", resolve);
    request.end();
  });
}

async function shutdownBackend() {
  const processHandle = backend;
  await requestBackendShutdown();
  if (processHandle && processHandle.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => processHandle.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 8_000))
    ]);
  }
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill();
    await Promise.race([
      new Promise((resolve) => processHandle.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
  }
  if (processHandle && processHandle.exitCode === null) throw new Error("工作台后端未能安全停止，已取消数据恢复");
  if (backend === processHandle) backend = null;
  backendLog?.end();
  backendLog = null;
  try {
    const state = readJson(runtimeStateFile, null);
    if (state?.launcherPid === process.pid) await fsp.rm(runtimeStateFile, { force: true });
  } catch { /* A stale diagnostic file is harmless. */ }
}

async function requestRestorePreflight(name) {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify({ name });
    const request = http.request({
      hostname: "127.0.0.1",
      port: backendPort,
      path: "/api/internal/launcher/restore-preflight",
      method: "POST",
      timeout: 5 * 60_000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-metacode-launcher-token": launcherToken
      }
    }, (response) => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { payload += chunk; });
      response.on("end", () => {
        let result;
        try { result = JSON.parse(payload); } catch { return reject(new Error("恢复预检响应无效")); }
        if (response.statusCode === 200 && result.ready) resolve(result);
        else reject(new Error(result.error || result.checks?.filter((item) => !item.ok).map((item) => item.message).join("；") || "恢复预检未通过"));
      });
    });
    request.once("timeout", () => request.destroy(new Error("恢复预检超时")));
    request.once("error", reject);
    request.end(body);
  });
}

async function restoreBackup(name) {
  if (recoveryInFlight || quitStarted) throw new Error("工作台正在执行其他恢复或退出操作");
  if (path.basename(name) !== name || !/^personal-[A-Za-z0-9.-]+$/.test(name)) throw new Error("备份名称无效");
  await requestRestorePreflight(name);
  recoveryInFlight = true;
  await showRestoreProgress("正在安全关闭工作台服务");
  let recovery;
  let transaction;
  try {
    await shutdownBackend();
    await showRestoreProgress("正在验证并恢复个人数据");
    const modulePath = path.join(runtimeRoot(), "dist-server", "dataRecovery.js");
    recovery = await import(`${pathToFileURL(modulePath).href}?restore=${Date.now()}`);
    transaction = recovery.restorePersonalDataBackup({ dataDir: dataHome, backupDir: path.join(dataHome, "backups"), name });
    await showRestoreProgress("恢复完成，正在重新启动 Meta Code");
    recoveryPolicy.reset();
    await startBackend();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/?dataRestore=success&backup=${encodeURIComponent(name)}`);
    try {
      recovery.finalizePersonalDataRestore(transaction);
      transaction = null;
    } catch (cleanupError) {
      await fsp.appendFile(path.join(logDir, "desktop-launcher.log"), `${new Date().toISOString()} restore cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`, "utf8").catch(() => undefined);
    }
    return { ok: true };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (transaction && recovery) {
      try {
        await shutdownBackend();
        recovery.rollbackPersonalDataRestore(transaction);
        transaction = null;
        message = `${message}；已恢复到操作前的数据`;
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        await showFailure(new Error(`个人数据恢复失败，且自动回滚未完成：${rollbackMessage}`));
        throw new Error(`${message}；自动回滚未完成：${rollbackMessage}`);
      }
    }
    await fsp.appendFile(path.join(logDir, "desktop-launcher.log"), `${new Date().toISOString()} restore failed: ${message}\n`, "utf8").catch(() => undefined);
    try {
      if (backend && backend.exitCode === null) await shutdownBackend();
      recoveryPolicy.reset();
      await startBackend();
      await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/?dataRestore=failed&message=${encodeURIComponent(message)}`);
    } catch (startupError) {
      await showFailure(new Error(`个人数据恢复失败，原数据回滚后仍无法启动：${startupError instanceof Error ? startupError.message : String(startupError)}`));
    }
    throw error;
  } finally {
    recoveryInFlight = false;
  }
}

ipcMain.handle("metacode:restore-backup", async (event, name) => {
  const source = String(event.senderFrame?.url || "");
  if (!source.startsWith(`http://127.0.0.1:${backendPort}/`)) throw new Error("不允许从当前页面发起数据恢复");
  return restoreBackup(String(name || ""));
});

async function runHeadlessRestoreTest() {
  const response = await fetch(`http://127.0.0.1:${backendPort}/api/data/backups`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-metacode-api-token": apiToken },
    body: "{}"
  });
  const payload = await response.json();
  if (!response.ok || !payload?.backup?.name) throw new Error(`桌面恢复测试无法创建备份：${payload?.error || response.status}`);
  const sentinel = path.join(dataHome, "providers", "desktop-restore-sentinel.txt");
  await fsp.writeFile(sentinel, "changed-after-backup", "utf8");
  await restoreBackup(payload.backup.name);
  if (await fsp.readFile(sentinel, "utf8") !== "value-in-backup") throw new Error("桌面恢复测试未恢复备份数据");
  const leftovers = (await fsp.readdir(path.join(dataHome, "backups"))).filter((entry) => entry.startsWith("pre-restore-"));
  if (leftovers.length) throw new Error("桌面恢复测试遗留了临时回滚数据");
  console.log("desktop backup restore and coordinated backend restart passed");
}

async function boot() {
  createWindow();
  try {
    await startBackend();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
    if (!TEST_HEADLESS) mainWindow.show();
    if (TEST_HEADLESS && process.env.METACODE_DESKTOP_TEST_RESTORE === "1") {
      await runHeadlessRestoreTest();
      setTimeout(() => app.quit(), 250).unref();
      return;
    }
    const testCrashMs = Number(process.env.METACODE_DESKTOP_TEST_CRASH_BACKEND_MS || 0);
    if (TEST_HEADLESS && testCrashMs > 0) setTimeout(() => backend?.kill("SIGKILL"), testCrashMs).unref();
    const testExitMs = Number(process.env.METACODE_DESKTOP_TEST_EXIT_MS || 0);
    if (testExitMs > 0) setTimeout(() => app.quit(), testExitMs).unref();
  } catch (error) {
    if (TEST_HEADLESS) await showFailure(error);
    else await recoverBackend(error);
    if (TEST_HEADLESS) app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(boot).catch(showFailure);
  app.on("activate", () => { if (mainWindow) mainWindow.show(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitStarted) return;
    quitStarted = true;
    void shutdownBackend().finally(() => { allowQuit = true; app.quit(); });
  });
}
