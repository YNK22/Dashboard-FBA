import "./env";
import { checkAmazon } from "../src/lib/check";

/**
 * Vérifie la connexion à l'API Amazon, étape par étape :  npm run check-amazon
 * (aussi disponible dans le dashboard : page « Connexion Amazon »)
 */
checkAmazon().then((steps) => {
  for (const s of steps) console.log(`${s.ok ? "✅" : "❌"} ${s.label}\n   ${s.detail}\n`);
  if (steps.every((s) => s.ok)) console.log("Tout est bon : npm run sync  (la première synchro peut prendre plusieurs minutes)");
  else process.exit(1);
});
