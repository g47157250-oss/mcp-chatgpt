/** أحدث المهام + الإحصائيات — تستخدمها لوحة المهام (تحديث تلقائي كل 5 ثوانٍ) */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type") ?? undefined;
  const status = sp.get("status") ?? undefined;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit") ?? 20)));

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      provider: t.provider,
      model: t.model,
      type: t.type,
      prompt: (t.prompt || "").slice(0, 120),
      status: t.status,
      progress: t.progress,
      resultUrls: t.result_urls_json ? JSON.parse(t.result_urls_json) : [],
      errorMessage: t.error_message,
      attempts: (t.attempts_json || "[]") as string,
      attemptsCount: (() => { try { return JSON.parse(t.attempts_json || "[]").length; } catch { return 0; } })(),
      createdAt: t.created_at,
      completedAt: t.completed_at,
    })),
  });
}
