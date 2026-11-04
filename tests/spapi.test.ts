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

test("TVA sur les frais Amazon séparée (fee_tax) et détaillée par type de frais", () => {
  const money = (n: number) => ({ currencyAmount: n, currencyCode: "EUR" });
  const lines = parseTransaction(
    {
      transactionId: "T3",
      transactionType: "Shipment",
      description: "Order Payment",
      postedDate: "2026-10-09T08:00:00Z",
      relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "404-1" }],
      totalAmount: money(7.13),
      items: [
        {
          totalAmount: money(7.13),
          contexts: [{ contextType: "ProductContext", sku: "SKU1", quantityShipped: 1 }],
          breakdowns: [
            { breakdownType: "ProductCharges", breakdownAmount: money(13.3), breakdowns: [{ breakdownType: "OurPricePrincipal", breakdownAmount: money(13.3) }] },
            {
              breakdownType: "AmazonFees",
              breakdownAmount: money(-5.99),
              breakdowns: [
                {
                  breakdownType: "FBAPerUnitFulfillmentFee",
                  breakdownAmount: money(-2.73),
                  breakdowns: [
                    { breakdownType: "Base", breakdownAmount: money(-2.27) },
                    { breakdownType: "Tax", breakdownAmount: money(-0.46) },
                  ],
                },
                {
                  breakdownType: "Commission",
                  breakdownAmount: money(-3.26),
                  breakdowns: [
                    { breakdownType: "Base", breakdownAmount: money(-2.72) },
                    { breakdownType: "Tax", breakdownAmount: money(-0.54) },
                  ],
                },
              ],
            },
            {
              breakdownType: "DigitalServicesFee",
              breakdownAmount: money(-0.18),
              breakdowns: [
                { breakdownType: "Base", breakdownAmount: money(-0.15) },
                { breakdownType: "Tax", breakdownAmount: money(-0.03) },
              ],
            },
          ],
        },
      ],
    } as ApiTransaction,
    cfg,
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].revenue, 13.3);
  assert.equal(lines[0].tax, 0); // la TVA des frais n'est pas de la TVA sur ventes
  assert.equal(lines[0].fees, -5.14);
  assert.equal(lines[0].fee_tax, -1.03);
  assert.deepEqual(JSON.parse(lines[0].fee_detail!), {
    FBAPerUnitFulfillmentFee: [-2.27, -0.46],
    Commission: [-2.72, -0.54],
    DigitalServicesFee: [-0.15, -0.03],
  });
});

test("frais FBA offerts par Amazon (Promo sous le frais) et TVA retenue : comptés dans les frais", () => {
  const money = (n: number) => ({ currencyAmount: n, currencyCode: "EUR" });
  const [l] = parseTransaction(
    {
      transactionId: "T5",
      transactionType: "Shipment",
      description: "Order Payment",
      postedDate: "2026-08-12T08:00:00Z",
      relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "408-1" }],
      totalAmount: money(9.04),
      items: [
        {
          totalAmount: money(9.04),
          contexts: [{ contextType: "ProductContext", sku: "SKU1", quantityShipped: 1 }],
          breakdowns: [
            { breakdownType: "ProductCharges", breakdowns: [{ breakdownType: "OurPricePrincipal", breakdownAmount: money(12.11) }] },
            {
              breakdownType: "Tax",
              breakdowns: [
                { breakdownType: "OurPriceTax", breakdownAmount: money(1.12) },
                { breakdownType: "MarketplaceFacilitatorVAT-Principal", breakdownAmount: money(-1.12) },
              ],
            },
            {
              breakdownType: "AmazonFees",
              breakdowns: [
                {
                  breakdownType: "FBAPerUnitFulfillmentFee",
                  breakdowns: [
                    { breakdownType: "Base", breakdownAmount: money(-2.85) },
                    { breakdownType: "Promo", breakdownAmount: money(2.85) },
                  ],
                },
                {
                  breakdownType: "Commission",
                  breakdowns: [
                    { breakdownType: "Base", breakdownAmount: money(-1.57) },
                    { breakdownType: "Tax", breakdownAmount: money(-0.32) },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as ApiTransaction,
    cfg,
  );
  assert.equal(l.promo, 0); // la remise sur frais n'est pas une promotion client
  assert.equal(l.fees, -1.57); // -2,85 + 2,85 - 1,57
  assert.equal(l.fee_tax, -1.44); // TVA commission -0,32 + TVA retenue -1,12
  assert.equal(l.tax, 1.12);
  assert.deepEqual(JSON.parse(l.fee_detail!), {
    MarketplaceFacilitatorVAT: [0, -1.12],
    FBAPerUnitFulfillmentFee: [-2.85, 0],
    FeePromo: [2.85, 0],
    Commission: [-1.57, -0.32],
  });
});

test("prélèvement carte pour solde négatif et son remboursement : ignorés", () => {
  for (const [type, desc, amount] of [
    ["DebtRecovery", "DebtPayment", 46.8],
    ["ChargeRefund - ChargeRefund", "ChargeRefund", -46.8],
  ] as const) {
    const lines = parseTransaction({ transactionId: "T4", transactionType: type, description: desc, postedDate: "2026-01-09T08:00:00Z", totalAmount: { currencyAmount: amount, currencyCode: "EUR" } }, cfg);
    assert.equal(lines.length, 0, type);
  }
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
