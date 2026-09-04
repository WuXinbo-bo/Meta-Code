import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { defaultWorkbenchDataDir } from "./server/appPaths";
import { loadOrCreateDevelopmentApiToken, LOCAL_API_TOKEN_HEADER } from "./server/localApiSecurity";

const webPort = Number(process.env.WORKBENCH_WEB_PORT || 4339);
const apiPort = Number(process.env.WORKBENCH_API_PORT || process.env.PORT || 4338);
const developmentDataDir = process.env.METACODE_HOME
  || (process.env.METACODE_PROFILE ? `${defaultWorkbenchDataDir()}-${process.env.METACODE_PROFILE}` : defaultWorkbenchDataDir());
const apiToken = loadOrCreateDevelopmentApiToken(developmentDataDir);

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("node_modules/lucide-react") || id.includes("node_modules\\lucide-react")) return "vendor-icons";
          if (id.includes("node_modules/@tanstack/react-virtual") || id.includes("node_modules\\@tanstack\\react-virtual")) return "vendor-virtual";
          return undefined;
        }
      }
    }
  },
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
