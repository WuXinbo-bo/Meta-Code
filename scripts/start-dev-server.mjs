import { defaultWorkbenchDataDir } from "../server/appPaths.ts";

if (!process.env.METACODE_HOME && !process.env.WORKBENCH_DATA_DIR && !process.env.WORKBENCH_RUNTIME_DIR) {
  process.env.METACODE_HOME = process.env.METACODE_PROFILE
    ? `${defaultWorkbenchDataDir()}-${process.env.METACODE_PROFILE}`
    : defaultWorkbenchDataDir();
}
process.env.METACODE_PROCESS_ROLE = "development";
await import("../server/index.ts");
