import type { CatchPayload } from './alert-subscriptions';

const X_POST_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function rfc3986Encode(input: string): string {
  return encodeURIComponent(input)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return bytesToBase64(new Uint8Array(signature));
}

function oauthNonce(size = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function buildTweetText(payload: CatchPayload, dashboardUrl: string): string {
  const transition = payload.tierTransition.replace(/\brug\b/gi, 'critical risk');
  const shortMint = `${payload.mint.slice(0, 6)}...${payload.mint.slice(-4)}`;
  const detailsUrl = `${dashboardUrl.replace(/\/$/, '')}/`;
  const primarySignal = payload.triggerSignals?.[0]
    ?? (payload.reason === 'score_drop' ? 'Rapid score deterioration' : 'Tier crash detected');

  const lines = [
    `RISK ALERT: $${payload.symbol} ${transition}`,
    `Score ${payload.initialScore}->${payload.caughtScore} (-${payload.scoreDrop})`,
    `${primarySignal}`,
    `Mint ${shortMint}`,
    detailsUrl,
    '@BagsApp #Solana #Sentinel',
  ];

  let text = lines.join('\n');
  if (text.length <= 280) return text;

  const firstLine = `RISK ALERT: $${payload.symbol} ${transition}`;
  const secondLine = `Score ${payload.initialScore}->${payload.caughtScore} (-${payload.scoreDrop})`;
  const thirdLine = `Mint ${shortMint}`;
  const compact = [firstLine, secondLine, thirdLine, detailsUrl, '#Solana #Sentinel'].join('\n');
  if (compact.length <= 280) return compact;

  return compact.slice(0, 277) + '...';
}

function getDedupeKey(payload: CatchPayload): string {
  return `x:catch:${payload.mint}:${payload.caughtAt}`;
}

async function buildOAuthHeader(
  method: string,
  url: string,
  creds: XCredentials,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: oauthNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  const parameterString = Object.entries(oauthParams)
    .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as const)
    .sort(([ak, av], [bk, bv]) => {
      if (ak === bk) return av.localeCompare(bv);
      return ak.localeCompare(bk);
    })
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signatureBaseString = [
    method.toUpperCase(),
    rfc3986Encode(url),
    rfc3986Encode(parameterString),
  ].join('&');

  const signingKey = `${rfc3986Encode(creds.apiSecret)}&${rfc3986Encode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, signatureBaseString);

  const finalParams = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const headerValue = Object.entries(finalParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986Encode(k)}="${rfc3986Encode(v)}"`)
    .join(', ');

  return `OAuth ${headerValue}`;
}

export function hasXCredentials(creds: Partial<XCredentials> | null | undefined): creds is XCredentials {
  return Boolean(
    creds
    && creds.apiKey
    && creds.apiSecret
    && creds.accessToken
    && creds.accessTokenSecret,
  );
}

export async function postCatchToX(args: {
  kv: KVNamespace;
  payload: CatchPayload;
  creds: XCredentials;
  dashboardUrl: string;
}): Promise<boolean> {
  const { kv, payload, creds, dashboardUrl } = args;
  const dedupeKey = getDedupeKey(payload);
  const alreadyPosted = await kv.get(dedupeKey);
  if (alreadyPosted) return false;

  const endpoint = 'https://api.x.com/2/tweets';
  const authHeader = await buildOAuthHeader('POST', endpoint, creds);
  const text = buildTweetText(payload, dashboardUrl);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`X post failed: ${res.status} ${errBody}`);
  }

  await kv.put(dedupeKey, '1', { expirationTtl: X_POST_DEDUP_TTL_SECONDS });
  return true;
}
