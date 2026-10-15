import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "scripts", "start-workbench-macos.sh"), "utf8");

assert.match(source, /METACODE_NODE_BIN/, "launcher must support an explicit Node override");
assert.match(source, /versions[\\/]node[\\/]\*[\\/]bin[\\/]node/, "launcher must discover nvm versioned Node installations");
assert.match(source, /Node\.js 24/, "launcher must require Node.js 24 or newer");
assert.match(source, /METACODE_NPM_BIN/, "launcher must support an explicit npm override");
assert.match(source, /npm-cli\.js/, "launcher must diagnose bundled npm-cli.js");
assert.match(source, /缺少依赖且 npm 不可用/, "launcher must report missing npm separately from missing dependencies");
console.log("macOS launcher Node/npm diagnostics checks passed");
