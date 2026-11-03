// Charge le fichier .env pour les scripts en ligne de commande (Next.js le fait tout seul pour le serveur).
import fs from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
