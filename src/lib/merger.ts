/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح)
 * القواعد الحتمية: أي خطأ HTTP معلن (4xx/5xx بجسم error) = فشل نهائي فوري؛
 * أخطاء شبكتنا (timeout/fetch) = مؤقتة وتستمر بالاستعلام.
 */
import { fetchWithTimeout } from "./providers/types";
import { ProviderError } from "./keys";

export const MERGER_LIMITS = {
  maxVideos: 10,
  maxPerVideoMB: 200,
  maxOutputMB: 150,
  maxTotalSeconds: 600,
  retentionHours: 24,
};

const COMPLETED = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED = new Set(["error", "failed", "failure", "cancelled"]);

export interface MergeJobStatus {
  status: "processing" | "completed" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  finalError: boolean; // حتمي؟
}

function mergerBase(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}

export function mergerConfigured(): boolean {
  const b = mergerBase();
  return !!b && !b.includes("xxxxxxxx");
}

/** فحص جهوزية الخدمة بمهلة 4 ثوانٍ (يُستخدم في /api/health) */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetchWithTimeout(mergerBase() + "/api/config", { timeoutMs: 4_000 });
    return res.ok;
  } catch {
    return false;
  }
}

/** تحليل دفاعي لحالة الدمج — progress كسر 0..1 يُضرب في 100، وerror بلا status = فشل */
function parseJob(body: Record<string, unknown>): MergeJobStatus {
  let status = String(body.status ?? "").toLowerCase();
  const err = typeof body.error === "string" && body.error ? body.error : undefined;
  if (!status && err) status = "failed"; // الجسم فيه error بلا حقل status → فشل فورًا
  let progress = Number(body.progress ?? 0);
  if (progress > 0 && progress <= 1) progress *= 100; // كسر → نسبة
  if (COMPLETED.has(status)) {
    const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : undefined;
    const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : undefined;
    // فضّل videoUrl ثم downloadUrl ثم رابط الملف المباشر بالمعرّف
    const url = videoUrl ?? downloadUrl ?? (typeof body.jobId === "string" ? `${mergerBase()}/api/jobs/${body.jobId}/video` : undefined);
    return { status: "completed", progress: 100, videoUrl: url, downloadUrl, finalError: false };
  }
  if (FAILED.has(status)) {
    return { status: "failed", progress, error: err, finalError: true };
  }
  if (err && FAILED.has(err.toLowerCase().split(" ")[0])) {
    return { status: "failed", progress, error: err, finalError: true };
  }
  return { status: "processing", progress, error: err, finalError: false };
}

/** إنشاء مهمة دمج → POST /api/jobs */
export async function createMergeJob(videos: string[]): Promise<{ jobId: string }> {
  if (!mergerConfigured()) {
    throw new ProviderError(0, "خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE في متغيرات البيئة");
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(mergerBase() + "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
      timeoutMs: 30_000,
    });
  } catch (e) {
    throw new ProviderError(0, `network: ${(e as Error).message}`); // مؤقت
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ProviderError(res.status, String(body.error ?? `HTTP ${res.status}`)); // معلن → حتمي
  }
  const jobId = String(body.jobId ?? "");
  if (!jobId) throw new ProviderError(res.status, "لم يُعَد jobId من خدمة الدمج");
  return { jobId };
}

/** تشغيل المعالجة → POST /api/jobs/{id}/process (blocking ~10-15 ثانية) */
export async function processMergeJob(jobId: string): Promise<void> {
  const res = await fetchWithTimeout(`${mergerBase()}/api/jobs/${jobId}/process`, {
    method: "POST",
    timeoutMs: 60_000,
  }).catch((e) => {
    throw new ProviderError(0, `network: ${(e as Error).message}`); // مؤقت
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ProviderError(res.status, String(body.error ?? `HTTP ${res.status}`)); // معلن → حتمي
  }
}

/** استعلام الحالة → GET /api/jobs/{id} — 404 = فشل نهائي (حُذفت بعد 24 ساعة) */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${mergerBase()}/api/jobs/${jobId}`, { timeoutMs: 20_000 });
  } catch (e) {
    throw new ProviderError(0, `network: ${(e as Error).message}`); // مؤقت
  }
  if (res.status === 404) {
    return {
      status: "failed",
      progress: 0,
      error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      finalError: true,
    };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseJob(body);
  if (!res.ok && !parsed.finalError && res.status >= 400) {
    // خطأ HTTP معلن بجسم error → فشل نهائي (ما عدا شبكتنا)
    return { ...parsed, status: "failed", error: String(body.error ?? `HTTP ${res.status}`), finalError: true };
  }
  return parsed;
}

/** حذف مهمة دمج (تنظيف اختياري) */
export async function deleteMergeJob(jobId: string): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetchWithTimeout(`${mergerBase()}/api/jobs/${jobId}`, { method: "DELETE", timeoutMs: 15_000 });
    return res.ok || res.status === 404;
  } catch { return false; }
}
