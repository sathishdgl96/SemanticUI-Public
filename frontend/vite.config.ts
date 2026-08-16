/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Where the dev server proxies the API. Overridable so a second frontend can
// be pointed at a second backend -- which is how a browser pass gets run
// against freshly-built code while another server still holds port 8000.
const API_TARGET = process.env.SEMANTICUI_API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": API_TARGET,
      "/auth": API_TARGET,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
  },
});
