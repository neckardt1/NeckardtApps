import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadPublicBuildConfig } from "./build-config.ts";

const maintenance = fileURLToPath(new URL("./recall/index.html", import.meta.url));

export default defineConfig({
  plugins: [{
    name: "preserve-scriptless-maintenance",
    // Keep the approved static entry untouched, including inline CSS. In dev,
    // this also removes Vite's injected client from the maintenance page.
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        return context.filename === maintenance ? readFileSync(maintenance, "utf8") : html;
      }
    }
  }],
  base: "./",
  publicDir: false,
  define: { __SITE_PUBLIC_CONFIG__: JSON.stringify(loadPublicBuildConfig()) },
  build: {
    sourcemap: false,
    rollupOptions: {
      input: {
        apps: fileURLToPath(new URL("./index.html", import.meta.url)),
        recall: fileURLToPath(new URL("./recall/index.html", import.meta.url))
      }
    }
  }
});
