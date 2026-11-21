import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadPublicBuildConfig } from "../apps/recall/build-config.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const recall = join(repo, "apps", "recall");
const require = createRequire(join(recall, "package.json"));
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const out = process.argv[2] ? resolve(process.argv[2]) : join(repo, "_site");

// Fail on bad public config or stale output rather than packaging extra files.
loadPublicBuildConfig();
await mkdir(out);
execFileSync(process.execPath, [vite, "build", "--emptyOutDir", "--outDir", join(out, "recall")], { cwd: recall, stdio: "inherit" });
await copyFile(join(repo, "index.html"), join(out, "index.html"));
console.log("Built launcher and /recall/ entry.");
