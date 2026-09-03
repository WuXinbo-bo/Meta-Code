import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import os from "node:os";
import path from "node:path";
import { loadOrCreateDevelopmentApiToken, LOCAL_API_TOKEN_HEADER } from "./server/localApiSecurity";

const webPort = Number(process.env.WORKBENCH_WEB_PORT || 4339);
const apiPort = Number(process.env.WORKBENCH_API_PORT || process.env.PORT || 4338);
const developmentDataDir = process.env.METACODE_HOME || path.join(os.homedir(), `.metacode-${process.env.METACODE_PROFILE || "development"}`);
const apiToken = loadOrCreateDevelopmentApiToken(developmentDataDir);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    watch: {
      ignored: ["**/.runtime/**"]
    },
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, headers: { [LOCAL_API_TOKEN_HEADER]: apiToken } }
    }
  }
});
