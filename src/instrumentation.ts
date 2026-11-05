/**
 * Tâches de fond, tant que le serveur tourne :
 * - synchronisation Amazon toutes les SYNC_INTERVAL_MINUTES minutes ;
 * - scraping : runs automatiques des sources arrivées à échéance (vérifié toutes les 5 min).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { markInterruptedRuns, scheduleDueScrapes } = await import("./lib/scraper/run");
  try {
    markInterruptedRuns();
  } catch (e) {
    console.error("[scraping]", e);
  }
  const scrapeTick = () => {
    try {
      scheduleDueScrapes();
    } catch (e) {
      console.error("[scraping auto]", e);
    }
  };
  setTimeout(scrapeTick, 30_000);
  setInterval(scrapeTick, 5 * 60_000);

  const { getConfig, hasAmazonCredentials } = await import("./lib/config");
  const cfg = getConfig();
  if (!hasAmazonCredentials(cfg) || cfg.syncIntervalMinutes <= 0) return;

  const { kvGet } = await import("./lib/db");
  const { runSync } = await import("./lib/sync");
  const tick = () => {
    if (kvGet("demo") === "1") return;
    runSync().catch((e) => console.error("[sync auto]", e));
  };
  setTimeout(tick, 10_000);
  setInterval(tick, cfg.syncIntervalMinutes * 60_000);
  console.log(`[sync auto] activée toutes les ${cfg.syncIntervalMinutes} min`);
}
