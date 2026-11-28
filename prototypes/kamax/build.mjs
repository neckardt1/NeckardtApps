import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] || resolve(root, "dist/index.html"));
const bundle = await build({
  root,
  configFile: false,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    lib: { entry: resolve(root, "app.jsx"), name: "KamaxPreview", formats: ["iife"] },
    cssCodeSplit: false,
  },
});
const assets = bundle.output || bundle[0].output;
const js = assets.find((a) => a.type === "chunk").code;
const css = assets.find((a) => a.type === "asset" && a.fileName.endsWith(".css")).source;
const template = await readFile(resolve(root, "index.html"), "utf8");
// Allow the same tested preview to open offline from a single downloaded file.
const html = template
  .replace("</head>", () => "<style>" + css + "</style>\n</head>")
  .replace(
    '<script type="module" src="./app.jsx"></script>',
    () => "<script>" + js.replace(/<\/script/gi, "<\\/script") + "</script>",
  );
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(output);
