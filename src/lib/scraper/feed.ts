/**
 * Lecture d'un flux produits (catalogue fourni par le site, un réseau d'affiliation ou le fournisseur) :
 * XML (Google Shopping RSS/Atom, <product>…) ou CSV/TSV (séparateur « , », « ; », tabulation ou « | »).
 * Fonctions pures, sans dépendance (testées dans tests/scraper.test.ts).
 */
import { decodeEntities, normalizeEan } from "./extract";

export interface FeedItem {
  title: string;
  ean: string | null;
  price: number | null;
  currency: string | null;
  url: string | null;
}

// Noms de colonnes / balises reconnus (minuscules, sans espaces ni accents ni préfixe g:)
const TITLE = ["title", "name", "productname", "nom", "titre", "libelle", "designation", "nomproduit", "producttitle"];
const EAN = ["gtin", "ean", "ean13", "gtin13", "gtin14", "gtin12", "gtin8", "codeean", "barcode", "upc", "codebarre", "codesbarres", "eancode"];
const PRICE = ["saleprice", "price", "prix", "prixttc", "searchprice", "storeprice", "displayprice", "prixvente", "pricettc", "prixpublic"];
const URL_KEYS = ["link", "url", "producturl", "lien", "deeplink", "awdeeplink", "merchantdeeplink", "urlproduit"];
const CURRENCY = ["currency", "devise", "pricecurrency"];

const key = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(g|ns\d*|c):/, "")
    .replace(/[^a-z0-9]/g, "");

function priceOf(v: string | undefined): { price: number | null; currency: string | null } {
  if (!v) return { price: null, currency: null };
  const currency = v.match(/\b([A-Z]{3})\b/)?.[1] ?? (v.includes("€") ? "EUR" : null);
  let t = v.replace(/[^\d.,]/g, "");
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = t.replace(",", ".");
  const n = Number(t);
  return { price: Number.isFinite(n) && n > 0 ? n : null, currency };
}

function pick(fields: Map<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fields.get(k);
    if (v) return v;
  }
  return undefined;
}

function toItem(fields: Map<string, string>): FeedItem | null {
  const title = pick(fields, TITLE)?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  let ean: string | null = null;
  for (const k of EAN) {
    ean = normalizeEan(fields.get(k));
    if (ean) break;
  }
  const { price, currency } = priceOf(pick(fields, PRICE));
  const url = pick(fields, URL_KEYS)?.trim() || null;
  return { title: title.slice(0, 500), ean, price, currency: pick(fields, CURRENCY)?.trim().toUpperCase() || currency, url };
}

/* ---------- XML ---------- */

const RECORD_TAGS = ["item", "entry", "product", "produit", "offer", "article", "row"];

function parseXmlFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const tag of RECORD_TAGS) {
    const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
    for (const m of xml.matchAll(re)) {
      const fields = new Map<string, string>();
      for (const f of m[1].matchAll(/<([\w:-]+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
        const k = key(f[1]);
        let v = f[3] ?? "";
        if (!v && k === "link") v = f[2].match(/href=["']([^"']+)["']/i)?.[1] ?? ""; // Atom <link href="…"/>
        v = decodeEntities(v.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/<[^>]+>/g, " ")).trim();
        if (v && !fields.has(k)) fields.set(k, v);
      }
      const item = toItem(fields);
      if (item) out.push(item);
    }
    if (out.length) return out;
  }
  return out;
}

/* ---------- CSV ---------- */

function parseCsvRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function parseCsvFeed(text: string): FeedItem[] {
  const nl = text.search(/\r?\n/);
  const firstLine = nl < 0 ? text : text.slice(0, nl);
  const sep = ["\t", ";", "|", ","].map((s) => ({ s, n: firstLine.split(s).length })).sort((a, b) => b.n - a.n)[0].s;
  const rows = parseCsvRows(text, sep);
  if (rows.length < 2) return [];
  const header = rows[0].map(key);
  const out: FeedItem[] = [];
  for (const r of rows.slice(1)) {
    const fields = new Map<string, string>();
    header.forEach((h, i) => {
      const v = r[i]?.trim();
      if (h && v && !fields.has(h)) fields.set(h, v);
    });
    const item = toItem(fields);
    if (item) out.push(item);
  }
  return out;
}

/** Lit un flux produits XML ou CSV. Les lignes sans titre sont ignorées. */
export function parseFeed(text: string): FeedItem[] {
  const t = text.replace(/^﻿/, "").trimStart();
  return t.startsWith("<") ? parseXmlFeed(t) : parseCsvFeed(t);
}

/* ---------- Diagnostic d'un refus d'accès ---------- */

/** Nom de la protection anti-robots, d'après les en-têtes ou la page de refus. */
export function detectProtection(headers: Headers | Record<string, string>, body = ""): string | null {
  const h = (n: string) => (headers instanceof Headers ? headers.get(n) : headers[n.toLowerCase()]) ?? "";
  const server = h("server").toLowerCase();
  const b = body.slice(0, 50_000);
  if (h("cf-ray") || server.includes("cloudflare") || /cloudflare/i.test(b)) return "Cloudflare";
  if (h("x-datadome") || h("x-dd-b") || /datadome|captcha-delivery\.com/i.test(b)) return "DataDome";
  if (h("x-iinfo") || /incapsula|imperva/i.test(b)) return "Imperva";
  if (server.includes("akamaighost") || h("akamai-grn") || /reference&#32;&#35;|akamai/i.test(b)) return "Akamai";
  if (/perimeterx|px-captcha/i.test(b)) return "PerimeterX (HUMAN)";
  if (server.includes("sucuri") || h("x-sucuri-id")) return "Sucuri";
  return null;
}
