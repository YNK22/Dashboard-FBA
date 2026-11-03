import { NextResponse, type NextRequest } from "next/server";
import { bumpDataVersion, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET() {
  const rows = getDb().prepare("SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 500").all();
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  const b = (await req.json()) as { date?: string; label?: string; category?: string; amount?: number };
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !b.label || !Number.isFinite(Number(b.amount))) {
    return NextResponse.json({ error: "date (YYYY-MM-DD), libellé et montant requis" }, { status: 400 });
  }
  const r = getDb()
    .prepare("INSERT INTO expenses(date, label, category, amount) VALUES(?, ?, ?, ?)")
    .run(b.date, b.label.trim(), b.category?.trim() || null, Number(b.amount));
  bumpDataVersion();
  return NextResponse.json({ ok: true, id: r.lastInsertRowid });
}

export function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
  getDb().prepare("DELETE FROM expenses WHERE id = ?").run(id);
  bumpDataVersion();
  return NextResponse.json({ ok: true });
}
