import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.WORKBENCH_WEB_PORT || 4339);
const apiPort = Number(process.env.WORKBENCH_API_PORT || process.env.PORT || 4338);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    watch: {
      ignored: ["**/.runtime/**"]
    },
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`
    }
  }
});
