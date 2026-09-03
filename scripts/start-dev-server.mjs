import os from "node:os";
import path from "node:path";

if (!process.env.METACODE_HOME && !process.env.WORKBENCH_DATA_DIR && !process.env.WORKBENCH_RUNTIME_DIR) {
  process.env.METACODE_PROFILE = process.env.METACODE_PROFILE || "development";
  process.env.METACODE_HOME = path.join(os.homedir(), `.metacode-${process.env.METACODE_PROFILE}`);
}
process.env.METACODE_PROCESS_ROLE = "development";
await import("../server/index.ts");
