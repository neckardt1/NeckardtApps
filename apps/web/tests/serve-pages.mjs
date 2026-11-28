import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";

export async function servePages(out) {
  const files = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://127.0.0.1").pathname.replace(/^\/NeckardtApps(?=\/)/, "");
      const file = resolve(out, "." + path + (path.endsWith("/") ? "index.html" : ""));
      if (!file.startsWith(out + sep)) throw Error("Not found");
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(await readFile(join(out, "404.html")));
    }
  });
  await new Promise((yes, no) => files.on("error", no).listen(0, "127.0.0.1", yes));
  return { files, origin: "http://127.0.0.1:" + files.address().port };
}
