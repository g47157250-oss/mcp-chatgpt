/** إدارة المفاتيح — القائمة مع إخفاء إلزامي + إضافة مع رفض التكرار */
import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { listKeys, insertKey } from "@/lib/turso";
import { keyPublic, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const keys = await listKeys();
  // المفتاح الكامل لا يُعاد أبدًا — مقنّع فقط
  return NextResponse.json({ keys: keys.map(keyPublic) });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    provider?: string; api_key?: string; label?: string;
  };
  const provider = (body.provider ?? "").trim();
  const apiKey = (body.api_key ?? "").trim();
  if (!["kie", "cometapi"].includes(provider)) {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }
  const existing = await listKeys();
  if (existing.some((k) => k.provider === provider && k.api_key === apiKey)) {
    return NextResponse.json(
      { error: `هذا المفتاح مضاف مسبقًا لنفس المزود (${maskKey(apiKey)}) — لا يُقبل التكرار` },
      { status: 409 }
    );
  }
  const id = uuidv4();
  await insertKey({ id, provider, label: (body.label ?? "").slice(0, 60), api_key: apiKey });
  const row = existing && (await listKeys()).find((k) => k.id === id);
  return NextResponse.json({ key: row ? keyPublic(row) : { id, provider } }, { status: 201 });
}
