const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

app.setPath("userData", path.join(desktopDir, "electron"));

let mainWindow = null;
let backend = null;
let backendPort = 0;
let backendLog = null;
let allowQuit = false;
let quitStarted = false;

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

async function waitForBackend(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    if (!backend || backend.exitCode !== null) throw new Error(`后端提前退出（${backend?.exitCode ?? "unknown"}）`);
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
  backendLog = fs.createWriteStream(path.join(logDir, "desktop-backend.log"), { flags: "a", mode: 0o600 });
  backendPort = await allocatePort();
  backend = spawn(process.execPath, [entry], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(backendPort),
      METACODE_HOME: dataHome,
      METACODE_DESKTOP: "1",
      WORKBENCH_PACKAGED: "1",
      METACODE_LAUNCHER_TOKEN: launcherToken
    }
  });
  backend.stdout.pipe(backendLog, { end: false });
  backend.stderr.pipe(backendLog, { end: false });
  backend.once("exit", (code, signal) => {
    backendLog?.write(`\n[launcher] backend exited: code=${code} signal=${signal}\n`);
    if (!quitStarted && mainWindow && !mainWindow.isDestroyed()) void showFailure(new Error("Meta Code 后端意外退出，请重新启动应用"));
  });
  const status = await waitForBackend(backendPort);
  await writeJsonAtomic(runtimeStateFile, {
    schemaVersion: 1,
    productId: PRODUCT_ID,
    version: status.version,
    launcherPid: process.pid,
    backendPid: backend.pid,
    port: backendPort,
    startedAt: new Date().toISOString(),
    runtimeRoot: root
  });
  return status;
}

function loadingHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>html,body{height:100%;margin:0;background:#fff;color:#171918;font-family:"Segoe UI",sans-serif}body{display:grid;place-items:center}.loading{display:grid;justify-items:center;gap:14px}.mark{display:grid;width:48px;height:48px;place-items:center;border:1px solid #d7d9d7;border-radius:10px;font-size:11px;font-weight:700}.copy{display:grid;gap:4px;text-align:center}.copy strong{font-size:15px}.copy span{color:#777d79;font-size:11px}.line{width:120px;height:2px;overflow:hidden;background:#eceeed}.line:after{display:block;width:38%;height:100%;background:#252927;content:"";animation:load 1.8s ease-in-out infinite}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(365%)}}</style></head><body><div class="loading"><div class="mark">MC</div><div class="copy"><strong>Meta Code</strong><span id="status">正在启动工作台</span></div><div class="line"></div></div></body></html>`;
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml())}`);
  mainWindow.once("ready-to-show", () => { if (!TEST_HEADLESS) mainWindow?.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${backendPort}/`) || url.startsWith("data:text/html")) return;
    event.preventDefault();
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
    await mainWindow.webContents.executeJavaScript(`document.getElementById("status").textContent=${JSON.stringify(message)}`).catch(() => undefined);
    if (!TEST_HEADLESS) mainWindow.show();
  }
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.appendFile(path.join(logDir, "desktop-launcher.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  if (!TEST_HEADLESS) void dialog.showErrorBox("Meta Code 启动失败", `${message}\n\n日志：${logDir}`);
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
  await requestBackendShutdown();
  if (backend && backend.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => backend.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 8_000))
    ]);
  }
  if (backend && backend.exitCode === null) backend.kill();
  backendLog?.end();
  backendLog = null;
  try {
    const state = readJson(runtimeStateFile, null);
    if (state?.launcherPid === process.pid) await fsp.rm(runtimeStateFile, { force: true });
  } catch { /* A stale diagnostic file is harmless. */ }
}

async function boot() {
  createWindow();
  try {
    await startBackend();
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
    if (!TEST_HEADLESS) mainWindow.show();
    const testExitMs = Number(process.env.METACODE_DESKTOP_TEST_EXIT_MS || 0);
    if (testExitMs > 0) setTimeout(() => app.quit(), testExitMs).unref();
  } catch (error) {
    await showFailure(error);
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
