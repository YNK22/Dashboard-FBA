/**
 * Synchronisation automatique : tant que le serveur tourne, on interroge Amazon
 * toutes les SYNC_INTERVAL_MINUTES minutes.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
