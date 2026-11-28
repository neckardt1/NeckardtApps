import { consentOrigin, eventScope, linkScope, mcpIssuer, offlineScope } from '../_shared/mcp-oauth-metadata.ts';
const clientNames = { 'neckardt-muse': 'Muse', 'neckardt-chatgpt': 'ChatGPT' } as const;
type Client = keyof typeof clientNames;
export type Grant = { client: Client; subject: string; grant: string; scope: string };
type Call = (action: string, payload: Record<string, unknown>) => Promise<unknown>;
const opaque = /^nmc_([acr])_[A-Za-z0-9_-]{43}$/;
const digest = (text: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const hash = async (value: string) => Array.from(new Uint8Array(await digest(value)), b => b.toString(16).padStart(2, '0')).join('');
const handle = (kind: string) => 'nmc_' + kind + '_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
const client = (v: string | null): v is Client => v !== null && Object.hasOwn(clientNames, v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v);
const headers = { 'Cache-Control':'no-store', Pragma:'no-cache' };
const browserHeaders = { ...headers, 'Access-Control-Allow-Origin':consentOrigin, Vary:'Origin' };
const error = (name: string, status = 400, h: HeadersInit = headers) => Response.json({ error:name }, { status, headers:h });

function scopes(raw: string | null, id: Client) {
  const list = (raw ?? linkScope).split(' ');
  if (!list.includes(linkScope) || new Set(list).size !== list.length ||
      !list.every(s => s === linkScope || (id === 'neckardt-chatgpt' && (s === offlineScope || s === eventScope)))) return null;
  return list.sort().join(' ');
}

function unique(params: URLSearchParams) {
  return new Set(params.keys()).size === params.size;
}

function authorization(params: URLSearchParams, resource: string) {
  const id = params.get('client_id'), callback = params.get('redirect_uri');
  const state = params.get('state'), challenge = params.get('code_challenge');
  if (!unique(params) || !client(id) || !callback || callback.length > 512 || !state || state.length > 1024 ||
      !/^[\x21-\x7e]+$/.test(state) || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      params.get('code_challenge_method') !== 'S256' || params.get('response_type') !== 'code' ||
      (params.has('resource') && params.get('resource') !== resource)) return null;
  const allowed = new Set(['client_id','redirect_uri','state','code_challenge','code_challenge_method','response_type','resource','scope','response_mode']);
  if ([...params.keys()].some(k => !allowed.has(k)) || (params.has('response_mode') && params.get('response_mode') !== 'query')) return null;
  const scope = scopes(params.get('scope'), id);
  return scope && { client:id, callback, state, challenge, resource, scope };
}

function redirect(callback: string, state: string, key: string, value: string) {
  const dest = new URL(callback);
  dest.searchParams.set(key, value);
  dest.searchParams.set('state', state);
  dest.searchParams.set('iss', mcpIssuer);
  return Response.json({ redirect_uri:dest.href }, { headers:browserHeaders });
}

async function readForm(req: Request) {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
  if (Number(req.headers.get('content-length')) > 8192 || !req.body) return null;
  const reader = req.body.getReader(), parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const form = new URLSearchParams(await new Blob(parts as BlobPart[]).text());
  return unique(form) ? form : null;
}

export function createBroker(resource: string, db: Call, firstParty: (jwt: string) => Promise<string | null>) {
  async function inspect(token: string): Promise<Grant | null> {
    if (opaque.exec(token)?.[1] !== 'a') return null;
    const g = await db('inspect', { hash:await hash(token), resource }) as Partial<Grant> | null;
    if (!g || !client(g.client ?? null) || !uuid(g.subject) || !uuid(g.grant) || typeof g.scope !== 'string' ||
        scopes(g.scope, g.client!) !== g.scope) return null;
    return g as Grant;
  }
  async function consent(req: Request, form: URLSearchParams) {
    const bearer = /^Bearer ([^\s]+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!bearer || bearer[1].length > 16384) return error('access_denied', 401, browserHeaders);
    const owner = await firstParty(bearer[1]);
    if (!owner) return error('access_denied', 403, browserHeaders);
    const action = form.get('decision');
    form.delete('decision');
    if (action === 'review_disconnect' || action === 'disconnect') {
      const id = form.get('client_id');
      if (!client(id) || form.size !== 1 || !await db(action === 'disconnect' ? 'disconnect' : 'owner', { client:id, owner }))
        return error('access_denied', 403, browserHeaders);
      return Response.json({ name:clientNames[id], disconnected:action === 'disconnect' }, { headers:browserHeaders });
    }
    const a = authorization(form, resource);
    if (!a || !['review','deny','approve'].includes(action ?? '')) return error('invalid_request', 400, browserHeaders);
    const saved = { client:a.client, callback:a.callback, owner, resource, scope:a.scope, challenge:a.challenge };
    const code = action === 'approve' ? handle('c') : undefined;
    const allowed = await db(code ? 'approve' : 'review', code ? { ...saved, hash:await hash(code) } : saved);
    if (!allowed) return error('access_denied', 403, browserHeaders);
    if (code) return redirect(a.callback, a.state, 'code', code);
    if (action === 'deny') return redirect(a.callback, a.state, 'error', 'access_denied');
    return Response.json({ name:clientNames[a.client], scope:a.scope, redirect_uri:a.callback }, { headers:browserHeaders });
  }
  async function token(form: URLSearchParams, id: Client) {
    const type = form.get('grant_type');
    if (type !== 'authorization_code' && type !== 'refresh_token') return error('unsupported_grant_type');
    if (form.has('resource') && form.get('resource') !== resource) return error('invalid_target');
    const exchange = type === 'authorization_code';
    const allowed = exchange ? ['grant_type','client_id','resource','redirect_uri','code','code_verifier'] :
      ['grant_type','client_id','resource','refresh_token','scope'];
    if ([...form.keys()].some(k => !allowed.includes(k))) return error('invalid_request');
    const credential = form.get(exchange ? 'code' : 'refresh_token') ?? '';
    if (opaque.exec(credential)?.[1] !== (exchange ? 'c' : 'r')) return error('invalid_grant');
    const args: Record<string, unknown> = { client:id, resource, hash:await hash(credential) };
    if (exchange) {
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !form.get('redirect_uri')) return error('invalid_grant');
      args.challenge = base64url(new Uint8Array(await digest(verifier)));
      args.callback = form.get('redirect_uri');
    } else if (form.has('scope')) {
      const scope = scopes(form.get('scope'), id);
      if (!scope) return error('invalid_scope');
      args.scope = scope;
    }
    const access = handle('a'), refresh = handle('r');
    const result = await db(exchange ? 'exchange' : 'refresh', { ...args,
      access_hash:await hash(access), refresh_hash:await hash(refresh) }) as { scope:string; expires_in:number } | null;
    if (!result) return error('invalid_grant');
    return Response.json({ access_token:access, token_type:'Bearer', scope:result.scope, expires_in:result.expires_in,
      ...(result.scope.split(' ').includes(offlineScope) ? { refresh_token:refresh } : {}) }, { headers });
  }
  async function serve(req: Request, route: string) {
    const browser = route === 'consent';
    if (!browser && route !== 'token' && route !== 'revoke') return new Response(null, { status:404 });
    if (browser && req.headers.get('origin') !== consentOrigin) return error('access_denied', 403);
    if (browser && req.method === 'OPTIONS') return new Response(null, { status:204, headers:{ ...browserHeaders,
      'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'authorization, content-type' } });
    if (req.method !== 'POST') return new Response(null, { status:405, headers:{ ...headers, Allow:'POST' } });
    const form = await readForm(req);
    if (!form) return error('invalid_request', 400, browser ? browserHeaders : headers);
    if (browser) return consent(req, form);
    const id = form.get('client_id');
    if (!client(id) || req.headers.has('authorization') || form.has('client_secret')) return error('invalid_client', 401);
    if (route === 'token') return token(form, id);
    const credential = form.get('token');
    if (!credential || [...form.keys()].some(k => !['token','token_type_hint','client_id'].includes(k))) return error('invalid_request');
    if (['a','r'].includes(opaque.exec(credential)?.[1] ?? '')) await db('revoke', { client:id, hash:await hash(credential) });
    return new Response(null, { headers });
  }
  return { inspect, serve };
}
