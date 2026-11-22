import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIPv4 } from "node:net";
import { Buffer } from "node:buffer";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");

export function isOpenAIHost(host: string) {
  return /^(?:[a-z0-9-]+\.)*(?:chatgpt\.com|openai\.com)$/.test(host);
}

// Expose only an exact first-party hostname when a legitimate subscription is
// blocked by the origin policy. Callback paths and query parameters are private.
export function rejectedHost(value: unknown): { callback_host?: string } {
  if (typeof value !== "string") return {};
  try {
    const host = new URL(value).hostname;
    if (isOpenAIHost(host)) return {callback_host:host};
  } catch { /* Do not reflect unparseable input. */ }
  return {};
}

type KnownHost = "chatgpt.com" | "api.openai.com" | "platform.openai.com";
export type CallbackRejection =
  | {rule:"type" | "length" | "unparseable" | "scheme" | "credentials" | "fragment" | "port"}
  | {rule:"host", knownHost?:KnownHost};

function knownHostLabel(host: string): KnownHost | undefined {
  // These fixed public labels are solely for logging. They do not grant callback access.
  switch (host) {
    case "chatgpt.com": return "chatgpt.com";
    case "api.openai.com": return "api.openai.com";
    case "platform.openai.com": return "platform.openai.com";
    default: return undefined;
  }
}

export function validateUrl(value: unknown, allowedHosts: ReadonlySet<string>,
  onReject?: (failure: CallbackRejection) => void): URL {
  if (typeof value !== "string" || value.length > 4096) {
    onReject?.({rule:typeof value !== "string" ? "type" : "length"});
    throw Error("Invalid URL");
  }
  let url: URL;
  try { url = new URL(value); }
  catch (error) { onReject?.({rule:"unparseable"}); throw error; }

  let failure: CallbackRejection | undefined;
  if (url.protocol !== "https:") failure = {rule:"scheme"};
  else if (url.username || url.password) failure = {rule:"credentials"};
  else if (url.hash) failure = {rule:"fragment"};
  else if (url.port) failure = {rule:"port"};
  else if (!allowedHosts.has(url.hostname)) failure = {rule:"host", knownHost:knownHostLabel(url.hostname)};
  if (failure) {
    onReject?.(failure);
    throw Error("Unrecognized callback origin");
  }
  return url;
}

export function secretBytes(value: unknown) {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw Error("Invalid signing secret");
  const raw = value.slice(6);
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== raw)
    throw Error("Invalid signing secret");
  return bytes;
}

export function signedPost(body: object, id: string, subscriptionId: string, secrets: string[]) {
  const bytes = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatures = secrets.map(secret => {
    const digest = createHmac("sha256", secretBytes(secret)).update([id, timestamp, bytes].join("."));
    return "v1," + digest.digest("base64");
  });
  return { bytes, headers: {
    "content-type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
    "webhook-signature": signatures.join(" "), "x-mcp-subscription-id": subscriptionId,
  }};
}

type SignedPost = ReturnType<typeof signedPost>;
export type Transport = (url: URL, post: SignedPost) => Promise<{status: number, body: string, retryAfter?: string}>;

// Connect to the exact checked IP. SNI, certificate verification and Host still use the
// original hostname. Using a fresh request prevents connection reuse or redirects.
export const send: Transport = async (url, post) => {
  const timeout = AbortSignal.timeout(5000);
  const addresses = await Promise.race([
    resolve4(url.hostname),
    new Promise<never>((_, reject) => timeout.addEventListener("abort", () => reject(Error("timeout")), {once:true})),
  ]);
  if (!addresses.length || addresses.some(ip => !isIPv4(ip) || blocked.check(ip, "ipv4")))
    throw Error("Callback has no eligible public address");
  return await new Promise((resolve, reject) => {
    const req = request({
      hostname: addresses[0], servername: url.hostname, family: 4, port: 443,
      method: "POST", path: url.pathname + url.search, agent: false,
      headers: {...post.headers, host: url.hostname}, signal: timeout,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) response.destroy(Error("Oversize callback response"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({status: response.statusCode ?? 0,
        retryAfter:response.headers["retry-after"], body:Buffer.concat(chunks).toString("utf8")}));
    });
    req.on("error", reject);
    req.end(post.bytes);
  });
};

export async function challengeCallback(url: URL, id: string, secret: string, transport: Transport) {
  const challenge = randomUUID();
  const post = signedPost({type:"verification", challenge}, "verify_" + randomUUID(), id, [secret]);
  const result = await transport(url, post);
  if (result.status < 200 || result.status >= 300) return false;
  const echoed = JSON.parse(result.body)?.challenge;
  return typeof echoed === "string" && Buffer.byteLength(echoed) === Buffer.byteLength(challenge) &&
    timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
}
