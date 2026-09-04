import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const sourceFiles = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(relative);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) sourceFiles.push(relative);
  }
};
visit("src");

for (const file of sourceFiles.filter((item) => item !== path.join("src", "components", "ConfirmationProvider.tsx"))) {
  assert.equal(read(file).includes("window.confirm("), false, `${file} must use the workbench confirmation dialog`);
}

for (const directory of ["src"]) {
  const cssFiles = [];
  const collectCss = (current) => {
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const relative = path.join(current, entry.name);
      if (entry.isDirectory()) collectCss(relative);
      else if (entry.name.endsWith(".css")) cssFiles.push(relative);
    }
  };
  collectCss(directory);
  for (const file of cssFiles) assert.equal(/font-size:\s*(?:8|9|10)px/.test(read(file)), false, `${file} contains text below the 11px UI baseline`);
}

assert.match(read("src/main.tsx"), /ConfirmationProvider/);
assert.match(read("src/App.tsx"), /task-recovery-panel/);
assert.match(read("src/App.tsx"), /OperationCenter/);
assert.match(read("src/components/OperationCenter.tsx"), /runtime\.install/);
assert.match(read("src/components/OperationCenter.tsx"), /agent-market\.install/);
assert.match(read("server/index.ts"), /providerReadiness\(session\.engine/);
assert.match(read("server/index.ts"), /\/api\/data\/diagnostics\/export/);

console.log("UX confirmation, readability, recovery, operation, and diagnostics foundations passed");
