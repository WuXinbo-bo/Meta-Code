import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { validateWorkspaceDrop, workspaceNameFromPath } from "../src/workspaces/dropValidation.ts";

assert.deepEqual(validateWorkspaceDrop({ itemCount: 1, isDirectory: true, path: "D:\\Work\\Demo" }), { ok: true, path: "D:\\Work\\Demo" });
assert.match(validateWorkspaceDrop({ itemCount: 2, isDirectory: true, path: "D:\\Work" }).error, /一个文件夹/);
assert.match(validateWorkspaceDrop({ itemCount: 1, isDirectory: false, path: "D:\\Work\\a.txt" }).error, /文件夹/);
assert.match(validateWorkspaceDrop({ itemCount: 1, isDirectory: true, path: "" }).error, /桌面版/);
assert.equal(workspaceNameFromPath("D:\\项目\\Meta Code\\"), "Meta Code");
assert.equal(workspaceNameFromPath("/home/user/project/"), "project");

const main = await fs.readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const preload = await fs.readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
const packaging = await fs.readFile(new URL("./build-desktop-package.mjs", import.meta.url), "utf8");
assert.match(main, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
assert.match(preload, /webUtils\.getPathForFile/);
assert.match(packaging, /desktop", "preload\.cjs/);
console.log("Electron workspace folder drop bridge and validation passed");
