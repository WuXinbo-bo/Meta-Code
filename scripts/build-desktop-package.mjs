import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build } from "electron-builder";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const packagesRoot = path.resolve(process.env.METACODE_PACKAGE_ROOT || path.join(path.dirname(root), "Meta-Code-Packages"));
const versionRoot = path.join(packagesRoot, version);
const staging = path.join(versionRoot, ".staging");
const runtime = path.join(staging, "runtime");
const artifacts = path.join(versionRoot, "artifacts");
const dirOnly = process.argv.includes("--dir-only");

function assertPackagingPath(target) {
  const relative = path.relative(packagesRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`拒绝操作打包根目录之外的路径：${target}`);
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出码 ${code}`)));
  });
}

async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await run(process.execPath, [npmCli, ...args], cwd);
}

async function copy(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`缺少打包输入：${source}`);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.cp(source, destination, { recursive: true, force: true });
}

assertPackagingPath(versionRoot);
assertPackagingPath(staging);
assertPackagingPath(artifacts);
await fsp.mkdir(packagesRoot, { recursive: true });
await fsp.rm(staging, { recursive: true, force: true });
await fsp.rm(artifacts, { recursive: true, force: true });
await fsp.mkdir(path.join(staging, "desktop"), { recursive: true });
await fsp.mkdir(path.join(staging, "build"), { recursive: true });
await fsp.mkdir(runtime, { recursive: true });

console.log(`[desktop] output: ${versionRoot}`);
console.log("[desktop] compiling web and backend");
await runNpm(["run", "build"], root);

await copy(path.join(root, "desktop", "main.cjs"), path.join(staging, "desktop", "main.cjs"));
await copy(path.join(root, "desktop", "preload.cjs"), path.join(staging, "desktop", "preload.cjs"));
await copy(path.join(root, "public", "workbench.ico"), path.join(staging, "build", "icon.ico"));
await copy(path.join(root, "desktop", "installer.nsh"), path.join(staging, "build", "installer.nsh"));
await run(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [
  path.join(root, "scripts", "render-installer-logo.cjs"),
  "--source", path.join(root, "public", "meta-code-mark.svg"),
  "--output", path.join(staging, "build", "installerLogo.png")
], root);
await run("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-File", path.join(root, "scripts", "generate-installer-assets.ps1"),
  "-SourceLogo", path.join(staging, "build", "installerLogo.png"),
  "-OutputDirectory", path.join(staging, "build"),
  "-Version", version
], root);
await copy(path.join(root, "dist"), path.join(runtime, "dist"));
await copy(path.join(root, "dist-server"), path.join(runtime, "dist-server"));
await copy(path.join(root, "skills"), path.join(runtime, "skills"));
await copy(path.join(root, "server-assets"), path.join(runtime, "server-assets"));
await copy(path.join(root, "public"), path.join(runtime, "public"));
await fsp.mkdir(path.join(runtime, "scripts"), { recursive: true });
await copy(path.join(root, "scripts", "delegate-agent.mjs"), path.join(runtime, "scripts", "delegate-agent.mjs"));
await copy(path.join(root, "release.config.json"), path.join(runtime, "release.config.json"));
const sourceCommit = process.env.METACODE_SOURCE_COMMIT || "local";
const buildId = process.env.METACODE_BUILD_ID || `${version}-${sourceCommit}`;
await fsp.writeFile(path.join(runtime, "build-info.json"), `${JSON.stringify({ schemaVersion: 1, version, buildId, sourceCommit }, null, 2)}\n`, "utf8");

const runtimePackage = {
  name: "meta-code-runtime",
  productName: "Meta Code",
  version,
  private: true,
  type: "module",
  dependencies: packageJson.dependencies
};
await fsp.writeFile(path.join(runtime, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8");
await fsp.writeFile(path.join(runtime, "package-lock.json"), await fsp.readFile(path.join(root, "package-lock.json")));

console.log("[desktop] installing isolated production dependencies");
await runNpm(["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], runtime);

const desktopPackage = {
  name: "meta-code-desktop",
  productName: "Meta Code",
  version,
  private: true,
  main: "desktop/main.cjs",
  description: "Meta Code desktop workbench"
};
await fsp.writeFile(path.join(staging, "package.json"), `${JSON.stringify(desktopPackage, null, 2)}\n`, "utf8");

const config = {
  appId: "ai.metacode.desktop",
  productName: "Meta Code",
  electronVersion: packageJson.devDependencies.electron.replace(/^[^0-9]*/, ""),
  electronDist: path.join(root, "node_modules", "electron", "dist"),
  asar: true,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  directories: { output: artifacts, buildResources: path.join(staging, "build") },
  files: ["desktop/**/*", "package.json"],
  extraResources: [
    { from: runtime, to: "workbench", filter: ["**/*", "!node_modules{,/**/*}"] },
    { from: path.join(runtime, "node_modules"), to: "workbench/node_modules", filter: ["**/*"] }
  ],
  win: {
    icon: path.join(staging, "build", "icon.ico"),
    executableName: "Meta Code",
    requestedExecutionLevel: "asInvoker"
  },
  nsis: {
    artifactName: "Meta-Code-Setup-${version}-${arch}.${ext}",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    include: path.join(staging, "build", "installer.nsh"),
    installerSidebar: path.join(staging, "build", "installerSidebar.bmp"),
    uninstallerSidebar: path.join(staging, "build", "installerSidebar.bmp"),
    installerHeader: path.join(staging, "build", "installerHeader.bmp"),
    installerLanguages: ["zh_CN"],
    language: "2052",
    multiLanguageInstaller: false,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    shortcutName: "Meta Code",
    uninstallDisplayName: "Meta Code",
    deleteAppDataOnUninstall: false
  },
  portable: {
    artifactName: "Meta-Code-Portable-${version}-${arch}.${ext}",
    requestExecutionLevel: "user"
  },
  publish: null
};

console.log(`[desktop] building ${dirOnly ? "unpacked application" : "installer and portable application"}`);
const targets = dirOnly ? Platform.WINDOWS.createTarget(["dir"], Arch.x64) : Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64);
await build({ projectDir: staging, targets, config });

// electron-builder writes local absolute paths here; it is diagnostic output, not a release asset.
await fsp.rm(path.join(artifacts, "builder-debug.yml"), { force: true });
const files = (await fsp.readdir(artifacts, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const packagedFiles = [];
for (const name of files) {
  const file = path.join(artifacts, name);
  const content = await fsp.readFile(file);
  packagedFiles.push({ name, size: content.byteLength, sha256: crypto.createHash("sha256").update(content).digest("hex") });
}
const summary = {
  schemaVersion: 1,
  productName: "Meta Code",
  version,
  createdAt: new Date().toISOString(),
  sourceCommit,
  buildId,
  outputDirectory: "artifacts",
  files: packagedFiles
};
await fsp.writeFile(path.join(versionRoot, "package-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await fsp.rm(staging, { recursive: true, force: true });
console.log(`[desktop] complete: ${artifacts}`);
