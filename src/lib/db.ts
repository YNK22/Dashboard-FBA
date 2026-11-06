import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config";

/**
 * Base SQLite locale. Un seul fichier (DATABASE_PATH), créé automatiquement.
 * Tous les montants sont stockés en EUR.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id        TEXT PRIMARY KEY,
  purchase_date   TEXT NOT NULL,          -- ISO UTC
  last_updated    TEXT,
  status          TEXT,                   -- PENDING, UNSHIPPED, SHIPPED, CANCELLED...
  marketplace_id  TEXT,
  fulfilled_by    TEXT,                   -- AMAZON (FBA) / MERCHANT (FBM)
  is_business     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(purchase_date);

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id   TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  sku             TEXT,
  asin            TEXT,
  title           TEXT,
  quantity        INTEGER NOT NULL,
  currency        TEXT,
  sales_ttc       REAL NOT NULL,          -- prix payé par le client (article + port + emballage - promos), TTC
  vat             REAL NOT NULL,          -- TVA incluse dans sales_ttc
  unit_price_ttc  REAL,
  price_estimated INTEGER DEFAULT 0       -- 1 si le prix n'était pas encore connu (commande en attente)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_sku ON order_items(sku);

-- Lignes financières issues de l'API Finances (frais réels, remboursements, frais divers)
CREATE TABLE IF NOT EXISTS finance_lines (
  id               TEXT PRIMARY KEY,      -- transactionId#index
  transaction_id   TEXT NOT NULL,
  posted_date      TEXT NOT NULL,
  kind             TEXT NOT NULL,         -- shipment | refund | other
  transaction_type TEXT,
  description      TEXT,
  status           TEXT,
  order_id         TEXT,
  sku              TEXT,
  quantity         INTEGER,
  marketplace_id   TEXT,
  revenue          REAL DEFAULT 0,        -- montants signés tels que présentés par Amazon (EUR)
  tax              REAL DEFAULT 0,
  promo            REAL DEFAULT 0,
  fees             REAL DEFAULT 0,
  total            REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fin_order ON finance_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_fin_date ON finance_lines(posted_date);

-- Coût d'achat par SKU (saisi par vous)
CREATE TABLE IF NOT EXISTS products (
  sku         TEXT PRIMARY KEY,
  asin        TEXT,
  title       TEXT,
  cogs        REAL,                      -- prix d'achat unitaire HT (TTC si non assujetti)
  extra_cost  REAL DEFAULT 0,            -- autres coûts unitaires : prep, transport vers Amazon...
  updated_at  TEXT
);

-- Dépenses manuelles (publicité, logiciels, prep center...)
CREATE TABLE IF NOT EXISTS expenses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  date      TEXT NOT NULL,              -- YYYY-MM-DD
  label     TEXT NOT NULL,
  category  TEXT,
  amount    REAL NOT NULL               -- HT (TTC si non assujetti)
);

-- Estimations de frais Amazon (API Product Fees), pour les commandes pas encore réglées
CREATE TABLE IF NOT EXISTS fee_estimates (
  sku            TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  price          REAL NOT NULL,
  fees           REAL NOT NULL,
  fetched_at     TEXT NOT NULL,
  PRIMARY KEY (sku, marketplace_id)
);

-- Lots d'achat (FIFO) : chaque vente consomme les lots les plus anciens du SKU
CREATE TABLE IF NOT EXISTS lots (
  id           TEXT PRIMARY KEY,        -- "<envoi FBA>|<sku>" ou identifiant généré
  sku          TEXT NOT NULL,
  received_at  TEXT NOT NULL,           -- ISO, date d'entrée en stock (ordre FIFO)
  quantity     INTEGER NOT NULL,
  unit_cost    REAL,                    -- coût unitaire HT tout compris (achat + prep + transport) ; NULL = à saisir
  shipment_id  TEXT,                    -- envoi FBA d'origine
  source       TEXT NOT NULL,           -- fba_shipment | csv | manual
  note         TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_lots_sku ON lots(sku, received_at);

-- Envois FBA (Fulfillment Inbound API) : servent à créer les lots automatiquement
CREATE TABLE IF NOT EXISTS inbound_shipments (
  shipment_id   TEXT PRIMARY KEY,
  name          TEXT,
  status        TEXT,
  first_seen_at TEXT,
  received_at   TEXT,                  -- 1re fois vu en réception / clôturé
  updated_at    TEXT
);

-- Dernier état du stock FBA (FBA Inventory API)
CREATE TABLE IF NOT EXISTS inventory (
  sku             TEXT PRIMARY KEY,
  asin            TEXT,
  fnsku           TEXT,
  title           TEXT,
  condition       TEXT,
  fulfillable     INTEGER DEFAULT 0,
  inbound_working INTEGER DEFAULT 0,
  inbound_shipped INTEGER DEFAULT 0,
  inbound_receiving INTEGER DEFAULT 0,
  reserved        INTEGER DEFAULT 0,
  reserved_customer INTEGER DEFAULT 0,
  reserved_transfer INTEGER DEFAULT 0,
  reserved_processing INTEGER DEFAULT 0,
  unfulfillable   INTEGER DEFAULT 0,
  researching     INTEGER DEFAULT 0,
  total           INTEGER DEFAULT 0,
  updated_at      TEXT
);

-- Scraping : sites fournisseurs à parcourir, historique des passages, produits trouvés
CREATE TABLE IF NOT EXISTS scrape_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'hybrid',   -- sitemap | crawl | hybrid | feed
  start_urls    TEXT,                             -- une URL par ligne (sitemaps, pages catégorie, ou flux produits en mode feed)
  url_pattern   TEXT,                             -- filtre facultatif des URLs produit (texte ou expression régulière)
  interval_days INTEGER NOT NULL DEFAULT 21,
  auto          INTEGER NOT NULL DEFAULT 1,
  max_pages     INTEGER NOT NULL DEFAULT 2000,
  delay_ms      INTEGER NOT NULL DEFAULT 1000,
  next_run_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,                    -- running | success | error | cancelled | interrupted
  pages_seen    INTEGER NOT NULL DEFAULT 0,
  offers_seen   INTEGER NOT NULL DEFAULT 0,       -- fiches produit lues
  new_products  INTEGER NOT NULL DEFAULT 0,       -- EAN jamais vus (toutes sources)
  new_offers    INTEGER NOT NULL DEFAULT 0,       -- URLs produit nouvelles pour cette source
  errors        INTEGER NOT NULL DEFAULT 0,
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scrape_runs_source ON scrape_runs(source_id, started_at);

CREATE TABLE IF NOT EXISTS scrape_products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL,
  ean         TEXT,
  price       REAL,
  currency    TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  UNIQUE(source_id, url)
);
CREATE INDEX IF NOT EXISTS idx_scrape_products_ean ON scrape_products(ean);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

declare global {
  // eslint-disable-next-line no-var
  var __fbaDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (globalThis.__fbaDb) return globalThis.__fbaDb;
  const file = path.resolve(getConfig().databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  globalThis.__fbaDb = db;
  return db;
}

/** Colonnes ajoutées après la première version (bases existantes). */
function migrate(db: Database.Database): void {
  const cols = new Set((db.prepare("PRAGMA table_info(finance_lines)").all() as { name: string }[]).map((c) => c.name));
  // TVA facturée par Amazon sur ses frais (signée, comme fees) : non récupérable hors assujettissement
  if (!cols.has("fee_tax")) db.exec("ALTER TABLE finance_lines ADD COLUMN fee_tax REAL DEFAULT 0");
  // Détail des frais par type Amazon : JSON { "Commission": [HT, TVA], ... } (montants signés)
  if (!cols.has("fee_detail")) db.exec("ALTER TABLE finance_lines ADD COLUMN fee_detail TEXT");
  // Scraping : détail des erreurs d'un run (JSON [{ step, url, error }], 30 au plus)
  const runCols = new Set((db.prepare("PRAGMA table_info(scrape_runs)").all() as { name: string }[]).map((c) => c.name));
  if (!runCols.has("error_details")) db.exec("ALTER TABLE scrape_runs ADD COLUMN error_details TEXT");
}

/** Incrémenté à chaque écriture de données : invalide les caches de calcul (FIFO...). */
let version = 0;
export function bumpDataVersion(): void {
  version++;
}
export function dataVersion(): number {
  return version;
}

export function kvGet(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  getDb().prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
