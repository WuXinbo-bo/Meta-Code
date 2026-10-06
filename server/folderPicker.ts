import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_FOLDER_PICKER = path.join(ROOT, "server-assets", "FolderPicker.exe");

function existingDirectory(input: string) {
  try {
    return input && fs.statSync(input).isDirectory() ? input : "";
  } catch {
    return "";
  }
}

export async function pickFolder(initialPath = "", title = "选择 Meta Code Agent 工作区"): Promise<string | null> {
  const existingInitialPath = existingDirectory(initialPath);

  if (process.platform === "win32") {
    if (!fs.existsSync(WINDOWS_FOLDER_PICKER)) {
      throw new Error(`未找到原生文件夹选择器：${WINDOWS_FOLDER_PICKER}。请运行 scripts/build-folder-picker.ps1 生成它。`);
    }
    const { stdout } = await execFileAsync(
      WINDOWS_FOLDER_PICKER,
      ["--initial-path", existingInitialPath, "--title", title],
      {
        encoding: "utf8",
        windowsHide: true
      }
    );
    return stdout.trim() || null;
  }

  if (process.platform === "darwin") {
    const appleScriptString = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]+/g, " ")}"`;
    const location = existingInitialPath ? ` default location POSIX file ${appleScriptString(existingInitialPath)}` : "";
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", `POSIX path of (choose folder with prompt ${appleScriptString(title)}${location})`],
        { encoding: "utf8" }
      );
      return stdout.trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "-128" || /User canceled|用户取消|不允许操作/i.test(String((error as Error).message || ""))) return null;
      throw error;
    }
  }

  const args = ["--file-selection", "--directory", `--title=${title}`];
  if (existingInitialPath) args.push(`--filename=${existingInitialPath}/`);
  const { stdout } = await execFileAsync("zenity", args, { encoding: "utf8" });
  return stdout.trim() || null;
}
