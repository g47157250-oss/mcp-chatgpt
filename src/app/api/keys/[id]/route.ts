/** تعطيل/تنشيط يدوي وحذف مفتاح */
import { NextRequest, NextResponse } from "next/server";
import { getKey, updateKey, deleteKey } from "@/lib/turso";
import { keyPublic } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; status?: string; label?: string };
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });

  if (body.action === "disable") await updateKey(id, { status: "disabled" });
  else if (body.action === "enable") await updateKey(id, { status: "active", last_error: "" });
  else if (body.status) await updateKey(id, { status: body.status });
  if (body.label !== undefined) await updateKey(id, { label: body.label.slice(0, 60) });

  const updated = await getKey(id);
  return NextResponse.json({ key: updated ? keyPublic(updated) : null });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true });
}
