import "./env";
import { clearData, seedDemo } from "../src/lib/demo";

if (process.argv.includes("--clear")) {
  clearData();
  console.log("Base vidée. Lancez `npm run sync` pour importer vos vraies données Amazon.");
} else {
  const n = seedDemo();
  console.log(`${n} commandes de démonstration créées. Lancez \`npm run dev\` puis ouvrez http://localhost:3000`);
  console.log("Pour repartir de zéro avant de brancher Amazon : npm run demo -- --clear");
}
