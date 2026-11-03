import { getConfig, type AppConfig } from "../config";

/**
 * Client minimal pour l'Amazon Selling Partner API (SP-API).
 *
 * Authentification : Login with Amazon (LWA). On échange le refresh token contre un
 * access token (valable 1 h) qu'on envoie dans l'en-tête `x-amz-access-token`.
 * Depuis octobre 2023, plus besoin de signature AWS (IAM / SigV4).
 */

let cachedToken: { value: string; expiresAt: number } | null = null;

export class SpApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

export async function getAccessToken(cfg: AppConfig = getConfig()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(cfg.lwaTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SpApiError(
      `Échec de l'authentification LWA (${res.status}). Vérifiez SPAPI_CLIENT_ID / SPAPI_CLIENT_SECRET / SPAPI_REFRESH_TOKEN. Réponse : ${text}`,
      res.status,
      text,
    );
  }
  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/* ---------- Limitation de débit (token bucket par opération) ---------- */

interface Bucket {
  tokens: number;
  rate: number; // jetons / seconde
  burst: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

/** Quotas par défaut documentés par Amazon (requêtes/seconde, burst). */
export const RATE_LIMITS: Record<string, { rate: number; burst: number }> = {
  searchOrders: { rate: 0.0056, burst: 20 },
  getOrder: { rate: 0.5, burst: 30 },
  listTransactions: { rate: 0.5, burst: 10 },
  getMyFeesEstimates: { rate: 0.5, burst: 1 },
  getMarketplaceParticipations: { rate: 0.016, burst: 15 },
  getInventorySummaries: { rate: 2, burst: 2 },
  getShipments: { rate: 2, burst: 30 },
  getShipmentItemsByShipmentId: { rate: 2, burst: 30 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function takeToken(op: string): Promise<void> {
  const limit = RATE_LIMITS[op] ?? { rate: 1, burst: 5 };
  let b = buckets.get(op);
  if (!b) {
    b = { tokens: limit.burst, rate: limit.rate, burst: limit.burst, last: Date.now() };
    buckets.set(op, b);
  }
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 1000) * b.rate);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - b.tokens) / b.rate) * 1000);
    if (waitMs > 5000) console.log(`[sp-api] quota ${op} atteint, pause de ${Math.round(waitMs / 1000)} s…`);
    await sleep(waitMs);
  }
}

export interface RequestOptions {
  operation: string;
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
}

export async function spApiRequest<T>(opts: RequestOptions, cfg: AppConfig = getConfig()): Promise<T> {
  const url = new URL(opts.path, cfg.endpoint);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }

  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    await takeToken(opts.operation);
    const token = await getAccessToken(cfg);
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "DashboardFBA/0.1 (Language=TypeScript)",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();

    if (res.ok) return (text ? JSON.parse(text) : {}) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const limit = RATE_LIMITS[opts.operation];
      const minWait = limit ? 1000 / limit.rate : 2000;
      const wait = Math.min(Math.max(2 ** attempt * 1000, res.status === 429 ? minWait : 0), 200_000);
      console.log(`[sp-api] ${opts.operation} → HTTP ${res.status}, nouvel essai dans ${Math.round(wait / 1000)} s (${attempt}/${maxAttempts})`);
      await sleep(wait);
      continue;
    }
    if (res.status === 403) {
      throw new SpApiError(
        `Accès refusé (403) sur ${opts.operation}. Vérifiez que votre application a bien les rôles nécessaires ` +
          `(voir docs/GUIDE-CONNEXION-AMAZON.md, étape 3) et que vous avez ré-autorisé l'app après avoir ajouté des rôles. Détail : ${text}`,
        res.status,
        text,
      );
    }
    throw new SpApiError(`SP-API ${opts.operation} a échoué (HTTP ${res.status}) : ${text}`, res.status, text);
  }
}

/** Convertit un montant renvoyé par Amazon (string décimale ou nombre) en nombre. */
export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
