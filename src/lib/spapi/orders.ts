import { getConfig, toEur, vatRateFor, type AppConfig } from "../config";
import { num, spApiRequest } from "./client";

/**
 * Orders API v2026-01-01 (remplace l'Orders API v0, dépréciée).
 * `searchOrders` renvoie les commandes AVEC leurs articles en une seule requête.
 */

interface Money {
  amount?: string | number;
  currencyCode?: string;
}

interface Breakdown {
  type: string;
  subtotal?: Money;
}

export interface ApiOrderItem {
  orderItemId: string;
  quantityOrdered: number;
  product?: {
    asin?: string;
    title?: string;
    sellerSku?: string;
    price?: { unitPrice?: Money };
  };
  proceeds?: { proceedsTotal?: Money; breakdowns?: Breakdown[] };
  fulfillment?: { quantityFulfilled?: number; quantityUnfulfilled?: number };
}

export interface ApiOrder {
  orderId: string;
  createdTime: string;
  lastUpdatedTime: string;
  salesChannel?: { channelName?: string; marketplaceId?: string };
  programs?: string[];
  fulfillment?: { fulfillmentStatus?: string; fulfilledBy?: string };
  orderItems: ApiOrderItem[];
}

interface SearchOrdersResponse {
  orders: ApiOrder[];
  pagination?: { nextToken?: string };
  lastUpdatedBefore?: string;
  createdBefore?: string;
}

export interface OrderRow {
  order_id: string;
  purchase_date: string;
  last_updated: string;
  status: string;
  marketplace_id: string | null;
  fulfilled_by: string | null;
  is_business: number;
}

export interface OrderItemRow {
  order_item_id: string;
  order_id: string;
  sku: string | null;
  asin: string | null;
  title: string | null;
  quantity: number;
  currency: string;
  sales_ttc: number;
  vat: number;
  unit_price_ttc: number | null;
  price_estimated: number;
}

export type SearchParams =
  | { createdAfter: string; createdBefore?: string }
  | { lastUpdatedAfter: string; lastUpdatedBefore?: string };

/** Récupère toutes les pages de commandes correspondant aux critères. */
export async function* searchOrders(params: SearchParams, cfg: AppConfig = getConfig()) {
  let paginationToken: string | undefined;
  do {
    const res = await spApiRequest<SearchOrdersResponse>(
      {
        operation: "searchOrders",
        path: "/orders/2026-01-01/orders",
        // Les pages suivantes reprennent les mêmes critères + le jeton de pagination
        query: {
          ...params,
          marketplaceIds: cfg.marketplaces.map((m) => m.id),
          includedData: ["PROCEEDS", "FULFILLMENT"],
          maxResultsPerPage: 100,
          paginationToken,
        },
      },
      cfg,
    );
    yield res;
    paginationToken = res.pagination?.nextToken;
  } while (paginationToken);
}

const sumType = (bds: Breakdown[] | undefined, ...types: string[]) =>
  (bds ?? []).filter((b) => types.includes(b.type)).reduce((s, b) => s + num(b.subtotal?.amount), 0);

/**
 * Transforme une commande de l'API en lignes pour la base.
 *
 * CA TTC d'une ligne = article + frais de port + emballage cadeau + autres − remises.
 * En Europe les prix affichés sont TTC. Si Amazon renvoie une ligne TAX séparée et que
 * le montant ITEM est HT (ITEM + TAX ≈ prix unitaire × quantité), on rajoute la taxe.
 */
export function parseOrder(o: ApiOrder, cfg: AppConfig = getConfig()): { order: OrderRow; items: OrderItemRow[] } {
  const marketplaceId = o.salesChannel?.marketplaceId ?? null;
  const vatRate = vatRateFor(marketplaceId, cfg);
  const order: OrderRow = {
    order_id: o.orderId,
    purchase_date: new Date(o.createdTime).toISOString(),
    last_updated: o.lastUpdatedTime,
    status: o.fulfillment?.fulfillmentStatus ?? "PENDING",
    marketplace_id: marketplaceId,
    fulfilled_by: o.fulfillment?.fulfilledBy ?? null,
    is_business: (o.programs ?? []).includes("AMAZON_BUSINESS") ? 1 : 0,
  };

  const items = (o.orderItems ?? []).map((it): OrderItemRow => {
    const qty = it.quantityOrdered ?? 0;
    const bds = it.proceeds?.breakdowns;
    const unit = it.product?.price?.unitPrice;
    const currency = it.proceeds?.proceedsTotal?.currencyCode ?? unit?.currencyCode ?? bds?.[0]?.subtotal?.currencyCode ?? "EUR";
    const unitPrice = unit ? num(unit.amount) : null;

    let salesTtc = 0;
    let vat = 0;
    let estimated = 0;

    if (bds && bds.length > 0) {
      const item = sumType(bds, "ITEM");
      const tax = sumType(bds, "TAX");
      const others = sumType(bds, "SHIPPING", "GIFT_WRAP", "COD_FEE", "OTHER");
      const discount = sumType(bds, "DISCOUNT");
      const discountSigned = discount > 0 ? -discount : discount; // une remise réduit toujours le CA
      let taxExclusive = false;
      if (tax > 0 && unitPrice && qty) {
        const expected = unitPrice * qty;
        taxExclusive = Math.abs(item + tax - expected) < Math.abs(item - expected);
      }
      salesTtc = item + others + discountSigned + (taxExclusive ? tax : 0);
      vat = tax > 0 ? tax : salesTtc - salesTtc / (1 + vatRate);
    } else if (unitPrice !== null && unitPrice > 0) {
      salesTtc = unitPrice * qty;
      vat = salesTtc - salesTtc / (1 + vatRate);
    } else {
      estimated = 1; // commande en attente : prix inconnu, estimé plus tard à partir de l'historique
    }

    const salesEur = toEur(salesTtc, currency, cfg);
    return {
      order_item_id: it.orderItemId,
      order_id: o.orderId,
      sku: it.product?.sellerSku ?? null,
      asin: it.product?.asin ?? null,
      title: it.product?.title ?? null,
      quantity: qty,
      currency,
      sales_ttc: round2(salesEur),
      vat: round2(toEur(vat, currency, cfg)),
      unit_price_ttc: qty > 0 && !estimated ? round2(salesEur / qty) : unitPrice !== null ? round2(toEur(unitPrice, currency, cfg)) : null,
      price_estimated: estimated,
    };
  });

  return { order, items };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
