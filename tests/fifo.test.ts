import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFifo, type Lot, type Sale } from "../src/lib/fifo";
import { shipmentDate } from "../src/lib/sync";
import { parseLotsCsv } from "../src/components/LotsPanel";

const lot = (id: string, receivedAt: string, quantity: number, unitCost: number | null): Lot => ({ id, sku: "A", receivedAt, quantity, unitCost });
const sale = (id: string, date: string, quantity: number): Sale => ({ id, sku: "A", date, quantity });

test("FIFO : les ventes consomment les lots les plus anciens", () => {
  const r = computeFifo(
    [lot("L2", "2026-02-01T00:00:00Z", 5, 12), lot("L1", "2026-01-01T00:00:00Z", 2, 10)],
    [sale("s1", "2026-02-10T00:00:00Z", 1), sale("s2", "2026-02-11T00:00:00Z", 2), sale("s3", "2026-02-12T00:00:00Z", 1)],
    new Map(),
  );
  assert.equal(r.costs.get("s1")!.unitCost, 10);
  assert.equal(r.costs.get("s2")!.unitCost, 11); // 1 × 10 + 1 × 12
  assert.equal(r.costs.get("s3")!.unitCost, 12);
  assert.deepEqual(
    r.lots.get("A")!.map((l) => l.remaining),
    [0, 3],
  );
});

test("FIFO : une vente ne consomme pas un lot reçu après elle, prix par défaut sinon", () => {
  const r = computeFifo([lot("L1", "2026-03-01T00:00:00Z", 3, 20)], [sale("old", "2026-01-15T00:00:00Z", 1), sale("new", "2026-03-05T00:00:00Z", 1)], new Map([["A", 15]]));
  assert.deepEqual(r.costs.get("old"), { unitCost: 15, source: "default" });
  assert.deepEqual(r.costs.get("new"), { unitCost: 20, source: "fifo" });
  assert.equal(r.lots.get("A")![0].remaining, 2);
});

test("FIFO : lot sans coût -> prix par défaut ou lot connu le plus proche, sinon inconnu", () => {
  const lots = [lot("L1", "2026-01-01T00:00:00Z", 1, 9), lot("L2", "2026-02-01T00:00:00Z", 5, null)];
  const sales = [sale("a", "2026-01-10T00:00:00Z", 1), sale("b", "2026-02-10T00:00:00Z", 1)];
  assert.deepEqual(computeFifo(lots, sales, new Map()).costs.get("b"), { unitCost: 9, source: "nearest" });
  assert.equal(computeFifo([lot("L", "2026-01-01T00:00:00Z", 2, null)], sales, new Map()).costs.get("a")!.unitCost, null);
});

test("date d'un envoi FBA déduite de son nom", () => {
  assert.equal(shipmentDate("FBA STA (03/11/2026 14:23)-CDG7"), "2026-11-03T14:23:00.000Z");
  assert.equal(shipmentDate("Envoi Facom"), null);
});

test("import CSV des lots : format simple et export Scorasin", () => {
  const simple = parseLotsCsv("sku;date;quantite;cout_unitaire_ht;envoi_fba\nA;21/04/2026;4;4,14;FBA15LPP31GX\nB;;2;3\n");
  assert.equal(simple.lots.length, 1);
  assert.equal(simple.skipped, 1);
  assert.deepEqual(simple.lots[0], { sku: "A", received_at: "2026-04-21T12:00:00.000Z", quantity: 4, unit_cost: 4.14, shipment_id: "FBA15LPP31GX" });

  const scorasin = parseLotsCsv(
    "merchant_sku,asin,quantity_received,received_at,unit_cog_ht,amazon_shipment_id,included_in_fifo\n" +
      "SKU1,B0,4,2026-10-08T11:30:29+00:00,12.3,FBA15MMW1KJW,true\n" +
      "SKU2,B1,1,2026-09-29T12:37:49+00:00,32.54,,false\n",
  );
  assert.equal(scorasin.lots.length, 1);
  assert.equal(scorasin.skipped, 1);
  assert.equal(scorasin.lots[0].unit_cost, 12.3);
  assert.equal(scorasin.lots[0].shipment_id, "FBA15MMW1KJW");
});
