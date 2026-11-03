import { getConfig, hasAmazonCredentials } from "./config";
import { getDb, kvGet, kvSet } from "./db";
import { parseOrder, searchOrders, type SearchParams } from "./spapi/orders";
import { listTransactions, parseTransaction } from "./spapi/finances";
import { estimateFees } from "./spapi/fees";

/**
 * Synchronisation Amazon -> base locale.
 *  1. Commandes (Orders API) : nouvelles commandes + changements de statut.
 *  2. Transactions financières (Finances API) : frais réels, remboursements, frais divers.
 *  3. Estimations de frais (Product Fees API) pour les produits sans historique.
 */

export interface SyncResult {
  ok: boolean;
  orders: number;
  financeLines: number;
  feeEstimates: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

let running: Promise<SyncResult> | null = null;

export function isSyncRunning(): boolean {
  return running !== null;
}

export function runSync(opts: { days?: number; log?: (msg: string) => void } = {}): Promise<SyncResult> {
  if (running) return running;
  running = doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync({ days, log = console.log }: { days?: number; log?: (msg: string) => void }): Promise<SyncResult> {
  const cfg = getConfig();
  const startedAt = new Date().toISOString();
  const result: SyncResult = { ok: false, orders: 0, financeLines: 0, feeEstimates: 0, startedAt, finishedAt: startedAt };
  if (!hasAmazonCredentials(cfg)) {
    result.error = "Identifiants SP-API absents : renseignez SPAPI_CLIENT_ID, SPAPI_CLIENT_SECRET et SPAPI_REFRESH_TOKEN dans .env";
    return result;
  }
  const db = getDb();
  kvSet("sync_running_since", startedAt);

  try {
    /* ---------- 1. Commandes ---------- */
    const ordersCursor = kvGet("orders_cursor");
    const initialDays = days ?? cfg.syncInitialDays;
    const params: SearchParams =
      ordersCursor && !days
        ? { lastUpdatedAfter: new Date(new Date(ordersCursor).getTime() - 10 * 60_000).toISOString() }
        : { createdAfter: new Date(Date.now() - initialDays * 86_400_000).toISOString() };
    log(`[sync] commandes : ${"createdAfter" in params ? `créées depuis ${params.createdAfter}` : `modifiées depuis ${params.lastUpdatedAfter}`}`);

    const upsertOrder = db.prepare(`
      INSERT INTO orders(order_id, purchase_date, last_updated, status, marketplace_id, fulfilled_by, is_business)
      VALUES(@order_id, @purchase_date, @last_updated, @status, @marketplace_id, @fulfilled_by, @is_business)
      ON CONFLICT(order_id) DO UPDATE SET last_updated=excluded.last_updated, status=excluded.status,
        marketplace_id=excluded.marketplace_id, fulfilled_by=excluded.fulfilled_by, is_business=excluded.is_business`);
    const deleteItems = db.prepare("DELETE FROM order_items WHERE order_id = ?");
    const insertItem = db.prepare(`
      INSERT OR REPLACE INTO order_items(order_item_id, order_id, sku, asin, title, quantity, currency, sales_ttc, vat, unit_price_ttc, price_estimated)
      VALUES(@order_item_id, @order_id, @sku, @asin, @title, @quantity, @currency, @sales_ttc, @vat, @unit_price_ttc, @price_estimated)`);
    const upsertProduct = db.prepare(`
      INSERT INTO products(sku, asin, title) VALUES(?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET asin=COALESCE(excluded.asin, products.asin), title=COALESCE(excluded.title, products.title)`);

    let cursor: string | undefined;
    for await (const page of searchOrders(params, cfg)) {
      db.transaction(() => {
        for (const apiOrder of page.orders ?? []) {
          const { order, items } = parseOrder(apiOrder, cfg);
          upsertOrder.run(order);
          deleteItems.run(order.order_id);
          for (const it of items) {
            insertItem.run(it);
            if (it.sku) upsertProduct.run(it.sku, it.asin, it.title);
          }
          result.orders++;
        }
      })();
      cursor = page.lastUpdatedBefore ?? page.createdBefore ?? cursor;
      log(`[sync]   ${result.orders} commandes traitées…`);
    }
    kvSet("orders_cursor", cursor ?? new Date(Date.now() - 3 * 60_000).toISOString());

    /* ---------- 2. Transactions financières ---------- */
    const finCursor = kvGet("finances_cursor");
    const finFrom =
      finCursor && !days
        ? new Date(new Date(finCursor).getTime() - 2 * 86_400_000) // recouvrement de 2 jours (transactions différées)
        : new Date(Date.now() - initialDays * 86_400_000);
    const finTo = new Date(Date.now() - 3 * 60_000);
    log(`[sync] finances : transactions depuis ${finFrom.toISOString()}`);

    const deleteTx = db.prepare("DELETE FROM finance_lines WHERE transaction_id = ?");
    const insertLine = db.prepare(`
      INSERT OR REPLACE INTO finance_lines(id, transaction_id, posted_date, kind, transaction_type, description, status, order_id, sku, quantity, marketplace_id, revenue, tax, promo, fees, total)
      VALUES(@id, @transaction_id, @posted_date, @kind, @transaction_type, @description, @status, @order_id, @sku, @quantity, @marketplace_id, @revenue, @tax, @promo, @fees, @total)`);

    // Fenêtres de 30 jours maximum
    for (let from = finFrom; from < finTo; ) {
      const to = new Date(Math.min(from.getTime() + 30 * 86_400_000, finTo.getTime()));
      for await (const txs of listTransactions(from, to, cfg)) {
        db.transaction(() => {
          for (const tx of txs) {
            const lines = parseTransaction(tx, cfg);
            if (tx.transactionId) deleteTx.run(tx.transactionId);
            for (const l of lines) insertLine.run(l);
            result.financeLines += lines.length;
          }
        })();
      }
      from = to;
    }
    kvSet("finances_cursor", finTo.toISOString());

    /* ---------- 3. Estimations de frais pour les produits sans historique ---------- */
    const needEstimates = db
      .prepare(
        `SELECT oi.sku, o.marketplace_id, MAX(oi.unit_price_ttc) AS price
         FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
         WHERE o.status != 'CANCELLED' AND oi.sku IS NOT NULL AND oi.unit_price_ttc > 0
           AND o.purchase_date >= ?
           AND NOT EXISTS (SELECT 1 FROM finance_lines f WHERE f.order_id = oi.order_id AND f.kind = 'shipment')
           AND NOT EXISTS (SELECT 1 FROM finance_lines f JOIN order_items oi2 ON oi2.order_id = f.order_id
                           WHERE oi2.sku = oi.sku AND f.kind = 'shipment')
           AND NOT EXISTS (SELECT 1 FROM fee_estimates fe WHERE fe.sku = oi.sku AND fe.marketplace_id = o.marketplace_id
                           AND fe.fetched_at >= ?)
         GROUP BY oi.sku, o.marketplace_id`,
      )
      .all(new Date(Date.now() - 14 * 86_400_000).toISOString(), new Date(Date.now() - 7 * 86_400_000).toISOString()) as {
      sku: string;
      marketplace_id: string;
      price: number;
    }[];
    if (needEstimates.length > 0) {
      log(`[sync] estimation des frais pour ${needEstimates.length} produit(s) sans historique`);
      const estimates = await estimateFees(
        needEstimates.map((r) => ({ sku: r.sku, marketplaceId: r.marketplace_id, priceTtc: r.price })),
        cfg,
      );
      const upsertEst = db.prepare(
        `INSERT OR REPLACE INTO fee_estimates(sku, marketplace_id, price, fees, fetched_at) VALUES(?, ?, ?, ?, ?)`,
      );
      for (const r of needEstimates) {
        const fees = estimates.get(`${r.sku}|${r.marketplace_id}`);
        if (fees !== undefined) {
          upsertEst.run(r.sku, r.marketplace_id, r.price, fees, new Date().toISOString());
          result.feeEstimates++;
        }
      }
    }

    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message;
    log(`[sync] ERREUR : ${result.error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    kvSet("sync_running_since", "");
    kvSet("last_sync", JSON.stringify(result));
    if (result.ok) kvSet("last_sync_ok_at", result.finishedAt);
  }
  log(`[sync] terminé : ${result.orders} commandes, ${result.financeLines} lignes financières, ${result.feeEstimates} estimations`);
  return result;
}

export function lastSync(): { last?: SyncResult; lastOkAt?: string | null } {
  const raw = kvGet("last_sync");
  return { last: raw ? (JSON.parse(raw) as SyncResult) : undefined, lastOkAt: kvGet("last_sync_ok_at") };
}
