import { getConfig, hasAmazonCredentials } from "./config";
import { bumpDataVersion, getDb, kvGet, kvSet } from "./db";
import { fetchInventory, fetchShipmentItems, fetchShipments } from "./spapi/inventory";
import { parseOrder, searchOrders, type SearchParams } from "./spapi/orders";
import { listTransactions, parseTransaction } from "./spapi/finances";
import { estimateFees } from "./spapi/fees";

/**
 * Synchronisation Amazon -> base locale.
 *  1. Commandes (Orders API) : nouvelles commandes + changements de statut.
 *  2. Transactions financières (Finances API) : frais réels, remboursements, frais divers.
 *  3. Estimations de frais (Product Fees API) pour les produits sans historique.
 *  4. Stock FBA (FBA Inventory API).
 *  5. Envois FBA (Fulfillment Inbound API) -> lots d'achat pour le coût FIFO.
 */

export interface SyncResult {
  ok: boolean;
  orders: number;
  financeLines: number;
  feeEstimates: number;
  inventorySkus: number;
  lots: number;
  warnings: string[];
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
  const result: SyncResult = {
    ok: false,
    orders: 0,
    financeLines: 0,
    feeEstimates: 0,
    inventorySkus: 0,
    lots: 0,
    warnings: [],
    startedAt,
    finishedAt: startedAt,
  };
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
      INSERT OR REPLACE INTO finance_lines(id, transaction_id, posted_date, kind, transaction_type, description, status, order_id, sku, quantity, marketplace_id, revenue, tax, promo, fees, fee_tax, fee_detail, total)
      VALUES(@id, @transaction_id, @posted_date, @kind, @transaction_type, @description, @status, @order_id, @sku, @quantity, @marketplace_id, @revenue, @tax, @promo, @fees, @fee_tax, @fee_detail, @total)`);

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

    /* ---------- 4. Stock FBA ---------- */
    const invMkt = cfg.marketplaces.find((m) => m.code === cfg.inventoryMarketplace) ?? cfg.marketplaces[0];
    if (invMkt) {
      try {
        const summaries = await fetchInventory(invMkt.id, cfg);
        const now = new Date().toISOString();
        const upsertInv = db.prepare(`
          INSERT OR REPLACE INTO inventory(sku, asin, fnsku, title, condition, fulfillable, inbound_working, inbound_shipped, inbound_receiving,
            reserved, reserved_customer, reserved_transfer, reserved_processing, unfulfillable, researching, total, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        db.transaction(() => {
          db.prepare("DELETE FROM inventory").run();
          for (const it of summaries) {
            if (!it.sellerSku) continue;
            const d = it.inventoryDetails ?? {};
            upsertInv.run(
              it.sellerSku,
              it.asin ?? null,
              it.fnSku ?? null,
              it.productName ?? null,
              it.condition ?? null,
              d.fulfillableQuantity ?? 0,
              d.inboundWorkingQuantity ?? 0,
              d.inboundShippedQuantity ?? 0,
              d.inboundReceivingQuantity ?? 0,
              d.reservedQuantity?.totalReservedQuantity ?? 0,
              d.reservedQuantity?.pendingCustomerOrderQuantity ?? 0,
              d.reservedQuantity?.pendingTransshipmentQuantity ?? 0,
              d.reservedQuantity?.fcProcessingQuantity ?? 0,
              d.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
              d.researchingQuantity?.totalResearchingQuantity ?? 0,
              it.totalQuantity ?? 0,
              now,
            );
            if (it.asin || it.productName) upsertProduct.run(it.sellerSku, it.asin ?? null, it.productName ?? null);
          }
        })();
        result.inventorySkus = summaries.length;
        log(`[sync] stock FBA : ${summaries.length} SKU`);
      } catch (e) {
        result.warnings.push(`Stock FBA : ${(e as Error).message}`);
        log(`[sync] stock FBA ignoré : ${(e as Error).message}`);
      }

      /* ---------- 5. Envois FBA -> lots d'achat ---------- */
      try {
        const shipCursor = kvGet("shipments_cursor");
        const since = shipCursor && !days ? new Date(new Date(shipCursor).getTime() - 86_400_000) : new Date(Date.now() - Math.max(initialDays, 90) * 86_400_000);
        const syncStart = new Date();
        const shipments = await fetchShipments(invMkt.id, since, cfg);
        const nowIso = syncStart.toISOString();
        const getShip = db.prepare("SELECT * FROM inbound_shipments WHERE shipment_id = ?");
        const upsertShip = db.prepare(`
          INSERT INTO inbound_shipments(shipment_id, name, status, first_seen_at, received_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(shipment_id) DO UPDATE SET name = excluded.name, status = excluded.status,
            received_at = COALESCE(inbound_shipments.received_at, excluded.received_at), updated_at = excluded.updated_at`);
        const upsertLot = db.prepare(`
          INSERT INTO lots(id, sku, received_at, quantity, unit_cost, shipment_id, source, updated_at)
          VALUES(?, ?, ?, ?, NULL, ?, 'fba_shipment', ?)
          ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at,
            received_at = CASE WHEN lots.source = 'fba_shipment' THEN excluded.received_at ELSE lots.received_at END`);
        const deleteLot = db.prepare("DELETE FROM lots WHERE id = ? AND source = 'fba_shipment' AND unit_cost IS NULL");

        for (const sh of shipments) {
          if (!sh.ShipmentId) continue;
          const prev = getShip.get(sh.ShipmentId) as { first_seen_at: string; received_at: string | null } | undefined;
          const received = ["RECEIVING", "CLOSED", "CHECKED_IN"].includes(sh.ShipmentStatus ?? "") ? nowIso : null;
          upsertShip.run(sh.ShipmentId, sh.ShipmentName ?? null, sh.ShipmentStatus ?? null, prev?.first_seen_at ?? nowIso, received, nowIso);
          const lotDate = shipmentDate(sh.ShipmentName) ?? prev?.received_at ?? received ?? prev?.first_seen_at ?? nowIso;
          const items = await fetchShipmentItems(sh.ShipmentId, invMkt.id, cfg);
          db.transaction(() => {
            for (const it of items) {
              if (!it.SellerSKU) continue;
              const id = `${sh.ShipmentId}|${it.SellerSKU}`;
              const qty = sh.ShipmentStatus === "CLOSED" ? (it.QuantityReceived ?? 0) : Math.max(it.QuantityShipped ?? 0, it.QuantityReceived ?? 0);
              if (qty <= 0 || ["CANCELLED", "DELETED"].includes(sh.ShipmentStatus ?? "")) deleteLot.run(id);
              else {
                upsertLot.run(id, it.SellerSKU, lotDate, qty, sh.ShipmentId, nowIso);
                result.lots++;
              }
            }
          })();
        }
        kvSet("shipments_cursor", nowIso);
        log(`[sync] envois FBA : ${shipments.length} envoi(s), ${result.lots} lot(s) mis à jour`);
      } catch (e) {
        result.warnings.push(`Envois FBA : ${(e as Error).message}`);
        log(`[sync] envois FBA ignorés : ${(e as Error).message}`);
      }
    }

    result.ok = true;
  } catch (e) {
    result.error = (e as Error).message;
    log(`[sync] ERREUR : ${result.error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    bumpDataVersion();
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

/**
 * Date de création d'un envoi, déduite de son nom par défaut Amazon,
 * ex. « FBA STA (03/11/2026 14:23)-CDG7 » (jour/mois/année sur les marketplaces européennes).
 */
export function shipmentDate(name: string | null | undefined): string | null {
  const m = name?.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
