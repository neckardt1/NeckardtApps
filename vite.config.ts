import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { loadPublicBuildConfig } from "./build-config.ts";

export default defineConfig({
  base: "./",
  publicDir: false,
  define: { __SITE_PUBLIC_CONFIG__: JSON.stringify(loadPublicBuildConfig()) },
  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        apps: fileURLToPath(new URL("./index.html", import.meta.url)),
        consent: fileURLToPath(new URL("./oauth/consent/index.html", import.meta.url)),
        recall: fileURLToPath(new URL("./recall/index.html", import.meta.url))
      }
    }
  }
});
