import "./env";
import { kvGet } from "../src/lib/db";
import { runSync } from "../src/lib/sync";

/**
 * Synchronisation manuelle :
 *   npm run sync                 -> synchro incrémentale (ou initiale si première fois)
 *   npm run sync -- --days 90    -> ré-importe les 90 derniers jours
 */
const idx = process.argv.indexOf("--days");
const days = idx > -1 ? Number(process.argv[idx + 1]) : undefined;

if (kvGet("demo") === "1") {
  console.error("La base contient des données de démonstration. Videz-la d'abord : npm run demo -- --clear");
  process.exit(1);
}

runSync({ days }).then((r) => {
  if (!r.ok) {
    console.error(`\nÉchec : ${r.error}`);
    process.exit(1);
  }
});
