import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadPublicBuildConfig } from "../build-config.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(repo, "package.json"));
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const out = process.argv[2] ? resolve(process.argv[2]) : join(repo, "_site");

// Validate before creating output, then refuse stale artifacts.
loadPublicBuildConfig();
await mkdir(out);
execFileSync(process.execPath, [vite, "build", "--emptyOutDir", "--outDir", out], { cwd: repo, stdio: "inherit" });
console.log("Built Apps and the scriptless /recall/ maintenance entry.");
