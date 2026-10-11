import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** npm's prebuilt spawn-helper can arrive without its executable mode. */
export function prepareNativePty(packageRoot = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), platform = process.platform, arch = process.arch) {
  if (platform === "win32") return;
  for (const directory of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = path.join(packageRoot, directory, "spawn-helper");
    if (!fs.existsSync(helper)) continue;
    const stat = fs.statSync(helper);
    if (!(stat.mode & 0o111)) fs.chmodSync(helper, stat.mode | 0o111);
  }
}
