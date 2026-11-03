import type { NextRequest } from "next/server";
import { getConfig } from "./config";
import { withMarketplace, type Scope } from "./queries";
import { addDays, parseYmdKey, startOfDay, type Range } from "./time";

/** Lit ?from=YYYY-MM-DD&to=YYYY-MM-DD (bornes incluses, jours locaux) et ?mkt=FR. */
export function readRange(req: NextRequest): { range: Range; scope: Scope } | null {
  const cfg = getConfig();
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const scope = withMarketplace(cfg, req.nextUrl.searchParams.get("mkt"));
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return {
    range: {
      from: startOfDay(parseYmdKey(from), cfg.timezone),
      to: new Date(Math.min(startOfDay(addDays(parseYmdKey(to), 1), cfg.timezone).getTime(), Date.now())),
    },
    scope,
  };
}

export function readScope(req: NextRequest): Scope {
  return withMarketplace(getConfig(), req.nextUrl.searchParams.get("mkt"));
}
