import { MARKETPLACES } from "./config";
import { getDb, kvSet } from "./db";

/**
 * Données de démonstration : permet de voir le dashboard fonctionner avant d'avoir
 * branché l'API Amazon. `npm run demo` remplit la base, `npm run demo -- --clear` la vide.
 */

const PRODUCTS = [
  { sku: "PLM-POKE-ETB", asin: "B0C8YQ1JRS", title: "Pokémon Coffret Dresseur d'Élite", price: 59.9, cogs: 21, fba: 4.2 },
  { sku: "RAV-PUZ-3000", asin: "B07DZTFRGF", title: "Ravensburger puzzle 3000 pièces", price: 34.99, cogs: 11.5, fba: 3.9 },
  { sku: "BOSCH-IXO", asin: "B0BX7J9KQ5", title: "Bosch IXO 7 visseuse sans fil", price: 54.99, cogs: 22, fba: 4.0 },
  { sku: "NIN-SW-CTRL", asin: "B01N6QKT7H", title: "Manette Nintendo Switch Pro", price: 64.99, cogs: 27, fba: 4.3 },
  { sku: "PLAY-70-CITY", asin: "B0BTF9QZ8Q", title: "Playmobil City Life maison moderne", price: 89.99, cogs: 34, fba: 6.2 },
  { sku: "BRA-ORALB-IO", asin: "B09B2VZ3JD", title: "Oral-B iO Series 6 brosse à dents électrique", price: 109.99, cogs: 41, fba: 4.6 },
  { sku: "TEF-INGENIO", asin: "B07PQ3VZ4Y", title: "Tefal Ingenio Emotion set 13 pièces", price: 119.0, cogs: 44, fba: 7.4 },
  { sku: "PHI-HUE-SK", asin: "B07Q4L1K7S", title: "Philips Hue White & Color starter kit", price: 129.99, cogs: 52, fba: 5.1 },
  { sku: "KRCH-OC3", asin: "B08D9J3H7W", title: "Kärcher OC 3 nettoyeur mobile", price: 129.0, cogs: 55, fba: 5.6 },
  { sku: "LEGO-42115", asin: "B08G4ZKXK1", title: "LEGO Technic Lamborghini Sián FKP 37", price: 379.99, cogs: 170, fba: 9.8 },
  { sku: "DYS-V8-ABS", asin: "B07YJ1JZ1B", title: "Dyson V8 Absolute aspirateur balai", price: 299.0, cogs: 128, fba: 7.9 },
  { sku: "LEGO-10305", asin: "B09QFNH5RT", title: "LEGO Icons Le château du roi Lion", price: 399.99, cogs: 185, fba: 10.5 },
];

// Répartition des ventes par marketplace
const MKT_WEIGHTS: [string, number][] = [
  ["FR", 0.55],
  ["DE", 0.2],
  ["IT", 0.1],
  ["ES", 0.1],
  ["BE", 0.05],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function clearData() {
  const db = getDb();
  db.exec("DELETE FROM orders; DELETE FROM order_items; DELETE FROM finance_lines; DELETE FROM fee_estimates; DELETE FROM expenses; DELETE FROM products; DELETE FROM kv;");
}

export function seedDemo(days = 430, now = new Date()) {
  const db = getDb();
  clearData();
  const rand = rng(42);
  const pick = <T,>(arr: [T, number][]) => {
    let x = rand();
    for (const [v, w] of arr) {
      if ((x -= w) <= 0) return v;
    }
    return arr[0][0];
  };

  const insProduct = db.prepare("INSERT INTO products(sku, asin, title, cogs, extra_cost, updated_at) VALUES(?, ?, ?, ?, ?, ?)");
  // le dernier produit n'a volontairement pas de prix d'achat, pour montrer l'alerte
  PRODUCTS.forEach((p, i) => insProduct.run(p.sku, p.asin, p.title, i === PRODUCTS.length - 1 ? null : p.cogs, 0.5, now.toISOString()));

  const insOrder = db.prepare(
    "INSERT INTO orders(order_id, purchase_date, last_updated, status, marketplace_id, fulfilled_by, is_business) VALUES(?, ?, ?, ?, ?, 'AMAZON', 0)",
  );
  const insItem = db.prepare(
    "INSERT INTO order_items(order_item_id, order_id, sku, asin, title, quantity, currency, sales_ttc, vat, unit_price_ttc, price_estimated) VALUES(?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 0)",
  );
  const insFin = db.prepare(
    `INSERT INTO finance_lines(id, transaction_id, posted_date, kind, transaction_type, description, status, order_id, sku, quantity, marketplace_id, revenue, tax, promo, fees, total)
     VALUES(?, ?, ?, ?, ?, ?, 'RELEASED', ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  );
  const insExpense = db.prepare("INSERT INTO expenses(date, label, category, amount) VALUES(?, ?, ?, ?)");

  let n = 0;
  db.transaction(() => {
    for (let dayOffset = days; dayOffset >= 0; dayOffset--) {
      const dayStart = new Date(now.getTime() - dayOffset * 86_400_000);
      dayStart.setUTCHours(0, 0, 0, 0);
      const growth = 0.45 + 0.55 * (1 - dayOffset / days); // l'activité grandit dans le temps
      const weekday = dayStart.getUTCDay();
      const weekend = weekday === 0 || weekday === 6 ? 1.15 : 1;
      const month = dayStart.getUTCMonth();
      const q4 = month === 10 ? 1.25 : month === 11 ? 1.6 : 1;
      const expected = 22 * growth * weekend * q4 * (0.7 + rand() * 0.6);
      const count = Math.round(expected);

      for (let k = 0; k < count; k++) {
        const t = new Date(dayStart.getTime() + Math.floor(rand() * 86_400_000));
        if (t > now) continue;
        const p = PRODUCTS[Math.floor(rand() ** 2.6 * PRODUCTS.length)];
        const code = pick(MKT_WEIGHTS);
        const mkt = MARKETPLACES.find((m) => m.code === code)!;
        const qty = rand() < 0.06 ? 2 : 1;
        const unit = Math.round(p.price * (0.92 + rand() * 0.12) * 100) / 100;
        const sales = Math.round(unit * qty * 100) / 100;
        const vat = Math.round((sales - sales / (1 + mkt.vatRate / 100)) * 100) / 100;
        const id = `40${n % 10}-${Math.floor(rand() * 9e6) + 1e6}-${String(n).padStart(7, "0")}`;
        const ageH = (now.getTime() - t.getTime()) / 3_600_000;
        const status = ageH < 5 ? "PENDING" : ageH < 20 ? "UNSHIPPED" : "SHIPPED";
        insOrder.run(id, t.toISOString(), t.toISOString(), status, mkt.id);
        insItem.run(`${id}-1`, id, p.sku, p.asin, p.title, qty, sales, vat, unit);

        // Règlement Amazon ~2 jours après la commande
        if (ageH > 48) {
          const posted = new Date(t.getTime() + 36 * 3_600_000).toISOString();
          const fees = -Math.round((sales * 0.15 + p.fba * qty) * 100) / 100;
          insFin.run(`tx-${id}`, `tx-${id}`, posted, "shipment", "Shipment", "Order Payment", id, p.sku, qty, mkt.id, sales, fees, Math.round((sales + fees) * 100) / 100);

          // ~3 % de remboursements, 10 à 25 jours plus tard
          if (rand() < 0.03) {
            const refundAt = new Date(t.getTime() + (10 + rand() * 15) * 86_400_000);
            if (refundAt < now) {
              const refundedFees = Math.round(sales * 0.15 * 0.8 * 100) / 100;
              insFin.run(`rf-${id}`, `rf-${id}`, refundAt.toISOString(), "refund", "Refund", "Refund Order", id, p.sku, qty, mkt.id, -sales, refundedFees, Math.round((-sales + refundedFees) * 100) / 100);
            }
          }
        }
        n++;
      }

      // Frais divers mensuels Amazon (abonnement le 1er, stockage le 8)
      const d = dayStart.getUTCDate();
      if (d === 1) insFin.run(`sub-${dayStart.toISOString()}`, `sub-${dayStart.toISOString()}`, dayStart.toISOString(), "other", "ServiceFee", "Abonnement vendeur professionnel", null, null, null, null, 0, -39, -39);
      if (d === 8) {
        const storage = -Math.round((60 + rand() * 80) * 100) / 100;
        insFin.run(`sto-${dayStart.toISOString()}`, `sto-${dayStart.toISOString()}`, dayStart.toISOString(), "other", "ServiceFee", "Frais de stockage FBA", null, null, null, null, 0, storage, storage);
      }
      if (d === 15) insExpense.run(dayStart.toISOString().slice(0, 10), "Publicité Sponsored Products", "Publicité", Math.round((150 + rand() * 120) * 100) / 100);
    }
  })();

  kvSet("demo", "1");
  kvSet("last_sync_ok_at", now.toISOString());
  return n;
}
