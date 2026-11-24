export interface PublicSupabaseConfig {
  url: string;
  publishableKey: string;
}

export function readPublicSupabaseConfig(input: unknown): PublicSupabaseConfig | null {
  if (input === null || typeof input !== "object" || !("url" in input) || !("publishableKey" in input)) return null;
  if (typeof input.url !== "string" || typeof input.publishableKey !== "string") return null;
  try {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
        || url.pathname !== "/" || url.username || url.password || url.port || url.search || url.hash
        || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(input.publishableKey)) return null;
    return { url: url.origin, publishableKey: input.publishableKey };
  } catch { return null; }
}

const options = {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
};

export function makeSiteClientGetter<Client>(
  createClient: (url: string, key: string, settings: typeof options) => Client
) {
  const clients = new Map<string, Client>();
  return (config: PublicSupabaseConfig) => {
    let client = clients.get(config.url);
    if (!client) {
      // Keep the SDK's project-based session key, not a path-based key.
      client = createClient(config.url, config.publishableKey, options);
      clients.set(config.url, client);
    }
    return client;
  };
}
