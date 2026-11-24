import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublicBuildConfig } from "./build-config.ts";

const migrations = fileURLToPath(new URL("../backend/supabase/migrations", import.meta.url));
const generator = fileURLToPath(new URL("../backend/scripts/generate-types.mjs", import.meta.url));
const generateTypes = () => execFileSync(process.execPath, [generator], { stdio: "inherit" });

export default defineConfig({
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [{
    name: "local-database-types",
    apply: "serve",
    configureServer(server) {
      generateTypes();
      server.watcher.add(migrations);
      server.watcher.on("all", (event, path) => {
        if (dirname(path) !== migrations || extname(path) !== ".sql"
          || !["add", "change", "unlink"].includes(event)) return;
        try {
          generateTypes();
        } catch {
          server.config.logger.error("Database types are stale. Fix the migration to regenerate them.");
        }
      });
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
        consent: fileURLToPath(new URL("./oauth/consent/index.html", import.meta.url))
      }
    }
  }
});
