import { defineConfig } from "vite";
import { loadPublicBuildConfig } from "./build-config.ts";

export default defineConfig({
  base: "./",
  define: { __RECALL_PUBLIC_CONFIG__: JSON.stringify(loadPublicBuildConfig()) },
  build: { sourcemap: false }
});
