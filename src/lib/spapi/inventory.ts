import { getConfig, type AppConfig } from "../config";
import { spApiRequest } from "./client";

/**
 * FBA Inventory API v1 — `getInventorySummaries` : stock FBA par SKU.
 * Fulfillment Inbound API v0 — `getShipments` / `getShipmentItemsByShipmentId` : envois vers Amazon,
 * utilisés pour créer automatiquement les lots d'achat (FIFO).
 */

export interface InventorySummary {
  asin?: string;
  fnSku?: string;
  sellerSku?: string;
  condition?: string;
  productName?: string;
  totalQuantity?: number;
  lastUpdatedTime?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedQuantity?: {
      totalReservedQuantity?: number;
      pendingCustomerOrderQuantity?: number;
      pendingTransshipmentQuantity?: number;
      fcProcessingQuantity?: number;
    };
    researchingQuantity?: { totalResearchingQuantity?: number };
    unfulfillableQuantity?: { totalUnfulfillableQuantity?: number };
  };
}

interface InventoryResponse {
  payload?: { inventorySummaries?: InventorySummary[] };
  pagination?: { nextToken?: string };
}

export async function fetchInventory(marketplaceId: string, cfg: AppConfig = getConfig()): Promise<InventorySummary[]> {
  const out: InventorySummary[] = [];
  let nextToken: string | undefined;
  do {
    const res = await spApiRequest<InventoryResponse>(
      {
        operation: "getInventorySummaries",
        path: "/fba/inventory/v1/summaries",
        query: { details: "true", granularityType: "Marketplace", granularityId: marketplaceId, marketplaceIds: [marketplaceId], nextToken },
      },
      cfg,
    );
    out.push(...(res.payload?.inventorySummaries ?? []));
    nextToken = res.pagination?.nextToken; // expire après 30 s : on enchaîne immédiatement
  } while (nextToken);
  return out;
}

export interface InboundShipment {
  ShipmentId?: string;
  ShipmentName?: string;
  ShipmentStatus?: string;
}

export interface InboundShipmentItem {
  ShipmentId?: string;
  SellerSKU?: string;
  QuantityShipped?: number;
  QuantityReceived?: number;
}

interface ShipmentsResponse {
  payload?: { ShipmentData?: InboundShipment[]; NextToken?: string };
}
interface ItemsResponse {
  payload?: { ItemData?: InboundShipmentItem[] };
}

const STATUSES = ["WORKING", "READY_TO_SHIP", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING", "CLOSED"];

export async function fetchShipments(marketplaceId: string, updatedAfter: Date, cfg: AppConfig = getConfig()): Promise<InboundShipment[]> {
  const out: InboundShipment[] = [];
  let nextToken: string | undefined;
  do {
    const res = await spApiRequest<ShipmentsResponse>(
      {
        operation: "getShipments",
        path: "/fba/inbound/v0/shipments",
        query: nextToken
          ? { QueryType: "NEXT_TOKEN", NextToken: nextToken, MarketplaceId: marketplaceId }
          : {
              QueryType: "DATE_RANGE",
              ShipmentStatusList: STATUSES,
              LastUpdatedAfter: updatedAfter.toISOString(),
              LastUpdatedBefore: new Date().toISOString(),
              MarketplaceId: marketplaceId,
            },
      },
      cfg,
    );
    out.push(...(res.payload?.ShipmentData ?? []));
    nextToken = res.payload?.NextToken;
  } while (nextToken);
  return out;
}

export async function fetchShipmentItems(shipmentId: string, marketplaceId: string, cfg: AppConfig = getConfig()): Promise<InboundShipmentItem[]> {
  const res = await spApiRequest<ItemsResponse>(
    {
      operation: "getShipmentItemsByShipmentId",
      path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`,
      query: { MarketplaceId: marketplaceId },
    },
    cfg,
  );
  return res.payload?.ItemData ?? [];
}
