import { defaultWorkbenchDataDir } from "../server/appPaths.ts";

if (!process.env.METACODE_HOME && !process.env.WORKBENCH_DATA_DIR && !process.env.WORKBENCH_RUNTIME_DIR) {
  process.env.METACODE_HOME = process.env.METACODE_PROFILE
    ? `${defaultWorkbenchDataDir()}-${process.env.METACODE_PROFILE}`
    : defaultWorkbenchDataDir();
}
process.env.METACODE_PROCESS_ROLE = "development";
// Keep npm dev, the PowerShell launcher and Vite on one configurable port
// contract. The server itself reads PORT, while Vite proxies through the
// corresponding WORKBENCH_API_PORT value.
const backendPort = process.env.WORKBENCH_API_PORT || process.env.METACODE_BACKEND_PORT || process.env.PORT || "4338";
process.env.WORKBENCH_API_PORT = backendPort;
process.env.PORT = backendPort;
await import("../server/index.ts");
