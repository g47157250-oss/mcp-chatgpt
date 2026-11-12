/** فحص صحة السيرفر — قاعدة البيانات، الكتالوج، خدمة الدمج، حالة التوثيق */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerHealthy, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await dbHealthy();
  const merger = await mergerHealthy();
  return NextResponse.json({
    ok: db,
    database: db ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerConfigured() ? process.env.MERGER_API_BASE : "not-configured", healthy: merger },
    authRequired: false, // التحديث 1.3.0: الـ MCP مفتوح دائمًا بدون تسجيل دخول
  });
}
