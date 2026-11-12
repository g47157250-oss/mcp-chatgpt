/**
 * التحديث 1.3.0 — ميزة دمج الفيديوهات من الواجهة:
 * يستقبل urls (روابط مباشرة) و/أو task_ids (مهام فيديو مكتملة) بالترتيب،
 * وينفّذ runMerge نفسها المستخدمة في أداة merge_videos عبر MCP.
 * الرد يحتوي task_id لمتابعة الدمج في لوحة المهام حيًا.
 */
import { NextRequest, NextResponse } from "next/server";
import { runMerge } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    urls?: string[];
    task_ids?: string[];
    wait_seconds?: number;
  };
  const result = await runMerge({
    urls: body.urls,
    task_ids: body.task_ids,
    wait_seconds: body.wait_seconds ?? 60,
  });
  return NextResponse.json(
    { message: result.text, taskId: result.taskId ?? null, isError: !!result.isError },
    { status: result.isError ? 400 : 200 }
  );
}
