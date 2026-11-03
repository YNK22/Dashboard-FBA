import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSummary, estimateLineFees, forecastMonth, pctChange, type SaleLine } from "../src/lib/metrics";

const line = (o: Partial<SaleLine> = {}): SaleLine => ({
  date: "2026-10-08T10:00:00.000Z",
  orderId: "A",
  sku: "SKU1",
  title: null,
  asin: null,
  marketplaceId: "A13V1IB3VIYZZH",
  status: "SHIPPED",
  quantity: 1,
  salesTtc: 120,
  vat: 20,
  fees: 25,
  feesEstimated: false,
  cogsUnit: 40,
  ...o,
});

const VAT = { vatRegistered: true, feesVatRate: 0.2 };

test("bénéfice, marge et ROI (assujetti TVA)", () => {
  const s = computeSummary([line()], [], [], VAT);
  assert.equal(s.salesTtc, 120);
  assert.equal(s.salesHt, 100);
  assert.equal(s.grossProfit, 35); // 100 - 25 - 40
  assert.equal(s.netProfit, 35);
  assert.ok(Math.abs(s.margin! - 0.35) < 1e-9);
  assert.ok(Math.abs(s.roi! - 0.875) < 1e-9);
});

test("non assujetti : pas de déduction de TVA, TVA ajoutée aux frais", () => {
  const s = computeSummary([line()], [], [], { vatRegistered: false, feesVatRate: 0.2 });
  assert.equal(s.salesHt, 120);
  assert.equal(s.amazonFees, 30);
  assert.equal(s.netProfit, 50); // 120 - 30 - 40
});

test("remboursement : coût = remboursé HT - frais rendus - stock récupéré", () => {
  const s = computeSummary(
    [line()],
    [{ date: "2026-10-20T00:00:00Z", orderId: "A", sku: "SKU1", quantity: 1, refundTtc: 120, vatBack: 20, feesNet: 12, cogsRecovered: 40 }],
    [],
    VAT,
  );
  assert.equal(s.refunds, 1);
  assert.equal(s.refundCost, 48); // 100 - 12 - 40
  assert.equal(s.netProfit, 35 - 48);
});

test("coûts divers, commandes en attente et coût d'achat manquant", () => {
  const s = computeSummary(
    [line(), line({ orderId: "B", status: "PENDING", feesEstimated: true, cogsUnit: null, quantity: 2, salesTtc: 240, vat: 40, fees: 50 })],
    [],
    [
      { date: "2026-10-01", label: "Abonnement", amount: 39, source: "amazon" },
      { date: "2026-10-15", label: "Pub", amount: 100, source: "manual" },
    ],
    VAT,
  );
  assert.equal(s.orders, 2);
  assert.equal(s.units, 3);
  assert.equal(s.pendingOrders, 1);
  assert.equal(s.pendingSalesTtc, 240);
  assert.equal(s.estimatedFeesSalesTtc, 240);
  assert.equal(s.missingCogsUnits, 2);
  assert.equal(s.otherCosts, 139);
});

test("variation et prévision", () => {
  assert.equal(pctChange(150, 100), 0.5);
  assert.equal(pctChange(10, 0), null);
  const mtd = computeSummary([line()], [], [], VAT);
  const f = forecastMonth(mtd, mtd, 1, 10, 30); // 20 jours restants à 120 €/jour
  assert.equal(f.salesTtc, 120 * 21);
});

test("estimation des frais : historique ajusté au prix, sinon pourcentage", () => {
  assert.equal(estimateLineFees(2, 110, 220, { feesPerUnit: 20, unitPriceTtc: 100 }, 0.35), 43); // (20 + 1.5) * 2
  assert.equal(estimateLineFees(1, 100, 100, undefined, 0.35), 35);
});
