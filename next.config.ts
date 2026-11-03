import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 est un module natif : il doit rester côté serveur, non bundlé.
  serverExternalPackages: ["better-sqlite3"],
  output: "standalone",
};

export default nextConfig;
