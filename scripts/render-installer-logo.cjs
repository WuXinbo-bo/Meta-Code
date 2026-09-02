const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

async function render() {
  const source = path.resolve(argument("--source"));
  const output = path.resolve(argument("--output"));
  if (!argument("--source") || !argument("--output")) throw new Error("需要 --source 和 --output");
  const svg = await fs.readFile(source, "utf8");
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    backgroundColor: "#ffffff",
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const html = `<!doctype html><html><head><style>html,body{width:100%;height:100%;margin:0;background:#fff;overflow:hidden}body{display:grid;place-items:center}svg{width:232px;height:232px}</style></head><body>${svg}</body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, image.toPNG());
  window.destroy();
}

app.disableHardwareAcceleration();
app.whenReady()
  .then(render)
  .then(() => app.quit())
  .catch((error) => { console.error(error); app.exit(1); });
