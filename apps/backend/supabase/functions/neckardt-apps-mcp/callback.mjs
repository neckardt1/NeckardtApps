import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import { BlockList, isIPv4 } from "node:net";
import { Duplex } from "node:stream";
import { Client } from "undici";

const callbackOrigin = "https://connectors.api.openai.com";
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.0.0.0",24], ["192.0.2.0",24],
  ["192.88.99.0",24], ["192.168.0.0",16], ["198.18.0.0",15], ["198.51.100.0",24],
  ["203.0.113.0",24], ["224.0.0.0",4], ["240.0.0.0",4],
]) blocked.addSubnet(network, prefix, "ipv4");

export function checkedUrl(raw) {
  if (typeof raw !== "string" || raw.length > 4096) throw Error("Invalid callback");
  const url = new URL(raw);
  if (url.origin !== callbackOrigin || url.username || url.password || url.hash)
    throw Error("Invalid callback");
  return url;
}

export function secretBytes(value) {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]{32,86}={0,2}$/.test(value))
    throw Error("Invalid secret");
  const bytes = Buffer.from(value.slice(6), "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== value.slice(6))
    throw Error("Invalid secret");
  return bytes;
}

export function signedPost(data, id, subscription, secret) {
  const body = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secretBytes(secret))
    .update([id, timestamp, body].join(".")).digest("base64");
  return { body, headers: { "content-type": "application/json", "webhook-id": id,
    "webhook-timestamp": timestamp, "webhook-signature": "v1," + signature,
    "x-mcp-subscription-id": subscription } };
}

export async function verifyCallback(url, id, secret, send) {
  const challenge = randomUUID();
  const post = signedPost({ type: "verification", challenge }, "verify_" + randomUUID(), id, secret);
  const result = await send(url, post);
  return result.status >= 200 && result.status < 300 && JSON.parse(result.body)?.challenge === challenge;
}

export function publicAddress(addresses) {
  if (!addresses.length || addresses.some(ip => !isIPv4(ip) || blocked.check(ip, "ipv4")))
    throw Error("No public callback address");
  return addresses[0];
}

// The Edge runtime's node:https adapter verifies the dialed IP as the TLS name.
// Dial the validated IP through Deno and complete TLS against the hostname before
// exposing the stream to Undici. Undici handles HTTP framing and response limits.
export async function sendCallback(url, post) {
  checkedUrl(url.href);
  const signal = AbortSignal.timeout(5000);
  let connection;
  let client;
  let aborted;
  const timeout = new Promise((_, reject) => { aborted = () => reject(Error("Callback timed out")); });
  const close = () => { try { connection?.close(); } catch { /* already closed */ } };
  const onAbort = () => { close(); aborted(); };
  signal.addEventListener("abort", onAbort, { once: true });
  async function send() {
    const address = publicAddress(await Deno.resolveDns(url.hostname, "A"));
    signal.throwIfAborted();
    connection = await Deno.connect({ hostname: address, port: 443 });
    if (signal.aborted) { close(); signal.throwIfAborted(); }
    connection = await Deno.startTls(connection, { hostname: url.hostname, alpnProtocols: ["http/1.1"] });
    if (signal.aborted) { close(); signal.throwIfAborted(); }
    await connection.handshake();
    if (signal.aborted) { close(); signal.throwIfAborted(); }
    // Deno 2.1's Duplex.fromWeb can throw during cancellation. Bridge the
    // TLS stream directly and let Undici own HTTP parsing and backpressure.
    const tls = connection;
    const socket = new Duplex({
      read(size) {
        const buffer = Buffer.alloc(Math.min(size, 16384));
        tls.read(buffer).then(n => this.push(n === null ? null : buffer.subarray(0,n)),
          error => this.destroy(error));
      },
      write(chunk, _encoding, done) {
        async function writeAll() {
          let offset = 0;
          while (offset < chunk.length) offset += await tls.write(chunk.subarray(offset));
        }
        writeAll().then(() => done(), done);
      },
      destroy(error, done) { close(); done(error); },
    });
    socket.ref = () => connection.ref();
    socket.unref = () => connection.unref();
    client = new Client(url.origin, { pipelining: 0, maxHeaderSize: 16384, maxResponseSize: 8192,
      connect(_options, done) { done(null, socket); } });
    const response = await client.request({ method: "POST", path: url.pathname + url.search,
      headers: post.headers, body: post.body, signal, maxRedirections: 0 });
    return { status: response.statusCode, body: await response.body.text() };
  }
  try { return await Promise.race([send(), timeout]); }
  finally {
    signal.removeEventListener("abort", onAbort);
    close();
    if (client) await client.destroy();
  }
}
