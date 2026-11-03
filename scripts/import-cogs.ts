import "./env";
import fs from "node:fs";
import { getDb } from "../src/lib/db";

/**
 * Importe vos prix d'achat depuis un CSV :  npm run import-cogs -- mon-fichier.csv
 * Colonnes : sku;prix_achat_ht[;cout_annexe]   (séparateur ; ou , — décimales avec , ou .)
 */
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("Usage : npm run import-cogs -- chemin/vers/fichier.csv");
  process.exit(1);
}
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
const sep = lines[0].includes(";") ? ";" : ",";
const parseNum = (s: string | undefined) => (s === undefined || s.trim() === "" ? null : Number(s.trim().replace(",", ".")));
const stmt = getDb().prepare(`
  INSERT INTO products(sku, cogs, extra_cost, updated_at) VALUES(?, ?, ?, ?)
  ON CONFLICT(sku) DO UPDATE SET cogs = excluded.cogs, extra_cost = COALESCE(excluded.extra_cost, products.extra_cost), updated_at = excluded.updated_at`);
let n = 0;
for (const line of lines) {
  const [sku, cogs, extra] = line.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());
  const value = parseNum(cogs);
  if (!sku || value === null || Number.isNaN(value)) continue; // ignore l'en-tête et les lignes invalides
  stmt.run(sku, value, parseNum(extra) ?? 0, new Date().toISOString());
  n++;
}
console.log(`${n} prix d'achat importés.`);
