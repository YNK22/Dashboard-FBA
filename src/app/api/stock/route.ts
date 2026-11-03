import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { stockOverview } from "@/lib/stock";

export const dynamic = "force-dynamic";

export function GET() {
  const cfg = getConfig();
  return NextResponse.json({
    ...stockOverview(cfg),
    settings: { reorderDays: cfg.reorderDays, targetStockDays: cfg.targetStockDays, overstockDays: cfg.overstockDays, marketplace: cfg.inventoryMarketplace },
  });
}
