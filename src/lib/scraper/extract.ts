/**
 * Extraction de données produit depuis le HTML d'une page, et lecture des sitemaps / robots.txt.
 * Fonctions pures, sans dépendance (testées dans tests/scraper.test.ts).
 *
 * Ordre de priorité : JSON-LD schema.org (Product), puis microdonnées (itemprop), puis balises meta.
 */

export interface ScrapedProduct {
  title: string;
  ean: string | null;
  price: number | null;
  currency: string | null;
  url: string;
}

/* ---------- Utilitaires ---------- */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»",
  hellip: "…", ndash: "–", mdash: "—", deg: "°", euro: "€", reg: "®", trade: "™", copy: "©", times: "×", oelig: "œ", OElig: "Œ", szlig: "ß",
};
// Lettres accentuées : &eacute; &Agrave; &ccedil; &ocirc; &uuml; …
const ACCENTS: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", cedil: "\u0327", ring: "\u030A" };
function namedEntity(name: string): string | undefined {
  if (ENTITIES[name]) return ENTITIES[name];
  const m = name.match(/^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring)$/);
  return m ? (m[1] + ACCENTS[m[2]]).normalize("NFC") : undefined;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => namedEntity(n) ?? namedEntity(n.toLowerCase()) ?? m);
}

const clean = (s: unknown): string => decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();

/** Vérifie un code EAN/GTIN (8, 12, 13 ou 14 chiffres) et sa clé de contrôle. */
export function isValidEan(code: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Normalise un EAN : chiffres seulement, GTIN-14 commençant par 0 ramené à 13 chiffres. */
export function normalizeEan(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return null;
  const code = d.length === 14 && d.startsWith("0") ? d.slice(1) : d;
  return isValidEan(code) ? code : null;
}

function parsePrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let t = String(v).replace(/[^\d.,]/g, "");
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function absolute(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? clean(content) : null;
}

/* ---------- JSON-LD ---------- */

type Json = Record<string, unknown>;

function jsonLdNodes(html: string): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      out.push(v as Json);
      const o = v as Json;
      if (o["@graph"]) walk(o["@graph"]);
      if (o.hasVariant) walk(o.hasVariant);
      if (o.mainEntity) walk(o.mainEntity);
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      // JSON-LD invalide : ignoré
    }
  }
  return out;
}

const isType = (n: Json, t: string) => {
  const ty = n["@type"];
  return (Array.isArray(ty) ? ty : [ty]).some((x) => String(x).toLowerCase() === t.toLowerCase());
};

function eanFromNode(n: Json): string | null {
  for (const k of ["gtin13", "gtin", "gtin14", "gtin12", "gtin8", "ean", "isbn"]) {
    const e = normalizeEan(n[k]);
    if (e) return e;
  }
  // Beaucoup de boutiques françaises mettent l'EAN dans le SKU / mpn
  for (const k of ["sku", "mpn", "productID"]) {
    const d = String(n[k] ?? "").replace(/^ean:/i, "");
    if (/^\d{13}$/.test(d) && isValidEan(d)) return d;
  }
  return null;
}

function offerOf(n: Json): { price: number | null; currency: string | null; url: string | null } {
  const offers = n.offers;
  const list = (Array.isArray(offers) ? offers : offers ? [offers] : []) as Json[];
  for (const o of list) {
    const price = parsePrice(o.price ?? o.lowPrice ?? (o.priceSpecification as Json | undefined)?.price);
    if (price !== null) return { price, currency: o.priceCurrency ? String(o.priceCurrency) : null, url: o.url ? String(o.url) : null };
  }
  return { price: null, currency: null, url: null };
}

/* ---------- Extraction d'une fiche produit ---------- */

/**
 * Renvoie le produit décrit par la page, ou null si la page n'est pas une fiche produit
 * (aucun Product schema.org, ni og:type=product, ni microdonnées Product).
 */
export function extractProduct(html: string, pageUrl: string): ScrapedProduct | null {
  const canonical = absolute(html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1], pageUrl);

  // 1. JSON-LD
  const products = jsonLdNodes(html).filter((n) => isType(n, "Product") || isType(n, "ProductGroup"));
  if (products.length > 0) {
    const main = products.find((p) => p.name) ?? products[0];
    const ean = eanFromNode(main) ?? products.map(eanFromNode).find(Boolean) ?? null;
    const offer = [main, ...products].map(offerOf).find((o) => o.price !== null) ?? { price: null, currency: null, url: null };
    const title = clean(main.name) || metaContent(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    if (title) {
      return {
        title: title.slice(0, 500),
        ean: ean ?? microdataEan(html),
        price: offer.price ?? parsePrice(metaContent(html, "product:price:amount")),
        currency: offer.currency ?? metaContent(html, "product:price:currency"),
        url: canonical ?? absolute(main.url ? String(main.url) : null, pageUrl) ?? pageUrl,
      };
    }
  }

  // 2. Microdonnées / Open Graph
  const isProduct =
    /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html) || /^product/i.test(metaContent(html, "og:type") ?? "");
  if (!isProduct) return null;
  const title =
    clean(html.match(/<[^>]+itemprop=["']name["'][^>]*>([^<]{2,})</i)?.[1]) ||
    metaContent(html, "og:title") ||
    clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]+>/g, "")) ||
    clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  if (!title) return null;
  return {
    title: title.slice(0, 500),
    ean: microdataEan(html),
    price: parsePrice(metaContent(html, "price") ?? metaContent(html, "product:price:amount")),
    currency: metaContent(html, "priceCurrency") ?? metaContent(html, "product:price:currency"),
    url: canonical ?? metaContent(html, "og:url") ?? pageUrl,
  };
}

function microdataEan(html: string): string | null {
  for (const m of html.matchAll(/<[^>]+itemprop=["'](gtin13|gtin|gtin14|gtin12|gtin8|ean)["'][^>]*>([^<]*)/gi)) {
    const content = m[0].match(/content=["']([^"']+)["']/i)?.[1];
    const e = normalizeEan(content ?? m[2]);
    if (e) return e;
  }
  for (const k of ["product:ean", "product:gtin", "gtin13", "ean"]) {
    const e = normalizeEan(metaContent(html, k));
    if (e) return e;
  }
  return null;
}

/* ---------- Pages anti-robots ---------- */

// Signatures propres aux pages de vérification (pas les scripts de protection chargés sur des pages normales)
const CHALLENGE = /cf-chl|\/cdn-cgi\/challenge-platform|<title>Just a moment\.\.\.|Attention Required! \| Cloudflare|captcha-delivery\.com|px-captcha|Request unsuccessful\. Incapsula|__blnCh/i;

/**
 * Page de vérification anti-robots (Cloudflare, DataDome, PerimeterX…) ou page vide remplie par JavaScript :
 * le contenu réel n'est pas lisible sans navigateur.
 */
export function isBotChallenge(html: string): boolean {
  if (CHALLENGE.test(html.slice(0, 200_000))) return true;
  const links = (html.match(/<a\b/gi) ?? []).length;
  return links <= 1 && html.length < 40_000 && /<script/i.test(html) && !/application\/ld\+json/i.test(html);
}

/* ---------- Liens ---------- */

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|gz|css|js|json|mp4|mp3|webm|woff2?|ttf|eot|xml|txt|csv|xlsx?|docx?)(\?|$)/i;
const TRACKING = /^(utm_|fbclid|gclid|mc_|ref$|srsltid)/i;

export const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

/** Normalise une URL : sans fragment ni paramètres de suivi. */
export function normalizeUrl(u: string): string {
  const url = new URL(u);
  url.hash = "";
  for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k);
  return url.toString();
}

/** Liens internes (même site) d'une page HTML. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const host = new URL(pageUrl).hostname;
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'#][^"']*)["']/gi)) {
    const abs = absolute(m[1], pageUrl);
    if (!abs || SKIP_EXT.test(abs)) continue;
    const u = new URL(abs);
    if (!sameSite(u.hostname, host) || /^(mailto|tel|javascript):/i.test(m[1])) continue;
    out.add(normalizeUrl(abs));
  }
  return [...out];
}

/* ---------- Sitemaps ---------- */

/** Lit un sitemap XML : sous-sitemaps (index) et URLs de pages. */
export function parseSitemap(xml: string): { sitemaps: string[]; urls: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1].trim()));
  return /<sitemapindex/i.test(xml) ? { sitemaps: locs, urls: [] } : { sitemaps: [], urls: locs };
}

/* ---------- robots.txt ---------- */

export interface Robots {
  rules: { allow: boolean; path: string }[];
  sitemaps: string[];
  crawlDelay: number | null; // secondes
}

/** Lit robots.txt : règles du groupe « * » (ou de notre robot), sitemaps, délai entre requêtes. */
export function parseRobots(txt: string, agent = "dashboardfba"): Robots {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; rules: Robots["rules"]; delay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "sitemap") {
      if (val) sitemaps.push(val);
      continue;
    }
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.rules.push({ allow: false, path: val });
    else if (key === "allow" && val) cur.rules.push({ allow: true, path: val });
    else if (key === "crawl-delay") cur.delay = Number(val) || null;
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  return { rules: mine?.rules ?? [], sitemaps, crawlDelay: mine?.delay ?? null };
}

function ruleMatches(rule: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      rule
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\\$$/, "$"),
  );
  return re.test(path);
}

/** La page est-elle autorisée par robots.txt ? (règle la plus longue gagnante, Allow à égalité) */
export function robotsAllows(robots: Robots, url: string): boolean {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}
