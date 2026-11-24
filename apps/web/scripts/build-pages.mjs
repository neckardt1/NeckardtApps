import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadPublicBuildConfig } from "../build-config.ts";
import { ownerDigest, sha256Hex } from "../src/oauth/flow.ts";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(webRoot, "package.json"));
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const out = process.argv[2] ? resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : resolve(webRoot, "../../_site");

// Validate before creating output, then refuse stale artifacts.
loadPublicBuildConfig();
const env = { ...process.env };
// Keep the existing synthetic pilot working during migration. Vite only receives its digest.
const legacyPilotId = env.RECALL_LEGACY_CANARY_USER_ID;
delete env.RECALL_LEGACY_CANARY_USER_ID;
if (!env.VITE_CANARY_USER_DIGEST && legacyPilotId) {
  env.VITE_CANARY_USER_DIGEST = await ownerDigest(legacyPilotId);
}
if (env.VITE_CANARY_USER_DIGEST && !sha256Hex.test(env.VITE_CANARY_USER_DIGEST)) {
  throw new Error("VITE_CANARY_USER_DIGEST must be a lowercase SHA-256 digest.");
}
await mkdir(out);
execFileSync(process.execPath, [vite, "build", "--emptyOutDir", "--outDir", out], { cwd: webRoot, stdio: "inherit", env });
await copyFile(join(webRoot, "404.html"), join(out, "404.html"));
console.log("Built the apps SPA, GitHub Pages fallback, and OAuth consent page.");
