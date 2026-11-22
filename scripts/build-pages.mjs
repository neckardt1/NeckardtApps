import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : join(repo, "_site");

// Refuse any existing destination: stale review assets must never ship.
// This explicit allowlist publishes no JavaScript, auth config, or backend files.
await mkdir(out);
await mkdir(join(out, "recall"));
await copyFile(join(repo, "index.html"), join(out, "index.html"));
await copyFile(join(repo, "apps", "recall", "index.html"), join(out, "recall", "index.html"));
console.log("Built public launcher and offline /recall/ entry.");
