import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/lib/config";
import { parseOrder, type ApiOrder } from "../src/lib/spapi/orders";
import { classifyPath, parseTransaction, type ApiTransaction } from "../src/lib/spapi/finances";
import { startOfDay, toYMD } from "../src/lib/time";

const cfg = getConfig();
const FR = "A13V1IB3VIYZZH";
const eur = (amount: number) => ({ amount: String(amount), currencyCode: "EUR" });

const order = (items: ApiOrder["orderItems"], status = "SHIPPED"): ApiOrder => ({
  orderId: "407-1234567-1234567",
  createdTime: "2026-10-08T09:12:00Z",
  lastUpdatedTime: "2026-10-08T12:00:00Z",
  salesChannel: { channelName: "AMAZON", marketplaceId: FR },
  fulfillment: { fulfillmentStatus: status, fulfilledBy: "AMAZON" },
  orderItems: items,
});

test("commande EU : prix TTC, TVA calculée au taux du pays", () => {
  const { order: o, items } = parseOrder(
    order([
      {
        orderItemId: "1",
        quantityOrdered: 2,
        product: { sellerSku: "SKU1", asin: "B0", price: { unitPrice: eur(60) } },
        proceeds: { proceedsTotal: eur(115), breakdowns: [{ type: "ITEM", subtotal: eur(120) }, { type: "DISCOUNT", subtotal: eur(-5) }] },
      },
    ]),
    cfg,
  );
  assert.equal(o.status, "SHIPPED");
  assert.equal(items[0].sales_ttc, 115);
  assert.equal(items[0].vat, 19.17); // 115 - 115/1.2
});

test("commande avec ligne TAX séparée et ITEM hors taxe : on rajoute la taxe", () => {
  const { items } = parseOrder(
    order([
      {
        orderItemId: "1",
        quantityOrdered: 1,
        product: { sellerSku: "SKU1", price: { unitPrice: eur(120) } },
        proceeds: { breakdowns: [{ type: "ITEM", subtotal: eur(100) }, { type: "TAX", subtotal: eur(20) }] },
      },
    ]),
    cfg,
  );
  assert.equal(items[0].sales_ttc, 120);
  assert.equal(items[0].vat, 20);
});

test("commande en attente sans prix : marquée comme estimée", () => {
  const { items } = parseOrder(order([{ orderItemId: "1", quantityOrdered: 1, product: { sellerSku: "SKU1" } }], "PENDING"), cfg);
  assert.equal(items[0].price_estimated, 1);
  assert.equal(items[0].sales_ttc, 0);
});

test("classification des montants financiers", () => {
  assert.equal(classifyPath(["Sales", "Product Charges", "Principle"]), "revenue");
  assert.equal(classifyPath(["Expenses", "Amazon fees", "Commission"]), "fee");
  assert.equal(classifyPath(["Expenses", "FBA fees"]), "fee");
  assert.equal(classifyPath(["Sales", "Tax"]), "tax");
  assert.equal(classifyPath(["Sales", "Promotion"]), "promo");
  assert.equal(classifyPath(["Shipping chargeback"]), "fee");
});

test("transaction d'expédition : frais par article + frais de commande", () => {
  const tx: ApiTransaction = {
    transactionId: "T1",
    transactionType: "Shipment",
    description: "Order Payment",
    postedDate: "2026-10-09T08:00:00Z",
    totalAmount: { currencyAmount: 72, currencyCode: "EUR" },
    relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "407-1" }],
    marketplaceDetails: { marketplaceId: FR },
    items: [
      {
        totalAmount: { currencyAmount: 75, currencyCode: "EUR" },
        contexts: [{ contextType: "ProductContext", sku: "SKU1", quantityShipped: 1 }],
        breakdowns: [
          { breakdownType: "Sales", breakdowns: [{ breakdownType: "Product Charges", breakdownAmount: { currencyAmount: 100, currencyCode: "EUR" } }] },
          {
            breakdownType: "Expenses",
            breakdowns: [
              { breakdownType: "Commission", breakdownAmount: { currencyAmount: -15, currencyCode: "EUR" } },
              { breakdownType: "FBA fees", breakdownAmount: { currencyAmount: -10, currencyCode: "EUR" } },
            ],
          },
        ],
      },
    ],
  };
  const lines = parseTransaction(tx, cfg);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "shipment");
  assert.equal(lines[0].sku, "SKU1");
  assert.equal(lines[0].revenue, 100);
  assert.equal(lines[0].fees, -25);
  assert.equal(lines[1].fees, -3); // reste non rattaché à un article
});

test("les virements vers la banque sont ignorés", () => {
  const lines = parseTransaction(
    { transactionId: "T2", transactionType: "Transfer", description: "Transfer of funds", postedDate: "2026-10-09T08:00:00Z", totalAmount: { currencyAmount: -1000, currencyCode: "EUR" } },
    cfg,
  );
  assert.equal(lines.length, 0);
});

test("début de journée à Paris, y compris aux changements d'heure", () => {
  assert.equal(startOfDay({ y: 2026, m: 10, d: 8 }, "Europe/Paris").toISOString(), "2026-10-07T22:00:00.000Z");
  assert.equal(startOfDay({ y: 2026, m: 11, d: 3 }, "Europe/Paris").toISOString(), "2026-11-02T23:00:00.000Z");
  assert.equal(startOfDay({ y: 2026, m: 10, d: 25 }, "Europe/Paris").toISOString(), "2026-10-24T22:00:00.000Z");
  assert.deepEqual(toYMD(new Date("2026-10-07T22:30:00Z"), "Europe/Paris"), { y: 2026, m: 10, d: 8 });
});
