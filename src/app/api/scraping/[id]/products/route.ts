import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

interface Row {
  title: string;
  ean: string | null;
  price: number | null;
  currency: string | null;
  url: string;
  first_seen: string;
  last_seen: string;
}

/**
 * Produits trouvés pour une source : ?q=texte|EAN&ean=1 (avec EAN seulement)&new=1 (nouveaux du dernier run)&page=1
 * ?format=csv : export complet (séparateur ;, UTF-8 avec BOM pour Excel).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const id = Number((await ctx.params).id);
  const p = req.nextUrl.searchParams;
  const db = getDb();
  const where = ["source_id = @id"];
  const q = (p.get("q") ?? "").trim();
  if (q) where.push("(title LIKE @like OR ean LIKE @like OR url LIKE @like)");
  if (p.get("ean") === "1") where.push("ean IS NOT NULL");
  if (p.get("new") === "1") {
    where.push("first_seen >= (SELECT started_at FROM scrape_runs WHERE source_id = @id ORDER BY id DESC LIMIT 1)");
  }
  const params = { id, like: `%${q}%` };
  const sql = `FROM scrape_products WHERE ${where.join(" AND ")}`;

  if (p.get("format") === "csv") {
    const rows = db.prepare(`SELECT title, ean, price, currency, url, first_seen, last_seen ${sql} ORDER BY title COLLATE NOCASE`).all(params) as Row[];
    const name = (db.prepare("SELECT name FROM scrape_sources WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "source";
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      "titre;ean;prix;devise;url;vu_la_premiere_fois;vu_la_derniere_fois",
      ...rows.map((r) =>
        [r.title, r.ean, r.price === null ? "" : String(r.price).replace(".", ","), r.currency, r.url, r.first_seen.slice(0, 10), r.last_seen.slice(0, 10)]
          .map(esc)
          .join(";"),
      ),
    ];
    return new NextResponse("﻿" + lines.join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="scraping-${name.replace(/[^\w.-]+/g, "_")}.csv"`,
      },
    });
  }

  const page = Math.max(1, Number(p.get("page")) || 1);
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(params) as { n: number }).n;
  const rows = db.prepare(`SELECT id, title, ean, price, currency, url, first_seen, last_seen ${sql} ORDER BY last_seen DESC, id DESC LIMIT 50 OFFSET @off`).all({
    ...params,
    off: (page - 1) * 50,
  });
  return NextResponse.json({ rows, total, page, pageSize: 50 });
}
