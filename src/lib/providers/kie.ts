/**
 * مزود kie.ai — Jobs API الموحد (الشكل الحقيقي المقاس بـ curl، مطابق للبرومبت):
 * POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
 * GET  /api/v1/jobs/recordInfo → {"data":{"state","resultJson":"{...نص JSON داخل JSON...}"}}
 */
import { ProviderError } from "../keys";
import { fetchWithTimeout, type ProviderAdapter, type ProviderKey, type TaskInput, type CheckResult } from "./types";

const BASE = "https://api.kie.ai";

/** حفر روابط النتائج من resultJson (نص JSON داخل JSON) بشكل دفاعي */
function extractUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const raw = data.resultJson;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const arr = parsed?.resultUrls ?? parsed?.resultArray ?? parsed?.urls;
      if (Array.isArray(arr)) {
        for (const u of arr) if (typeof u === "string") urls.push(u);
        // أحيانًا resultUrls عناصرها كائنات {url: ...}
        for (const o of arr) if (o && typeof o === "object" && typeof (o as { url?: string }).url === "string") urls.push((o as { url: string }).url);
      }
      if (typeof parsed?.url === "string") urls.push(parsed.url);
    } catch {
      // لا نص JSON صالح — نتجاهل
    }
  }
  if (Array.isArray(data.resultUrls)) {
    for (const u of data.resultUrls as unknown[]) {
      if (typeof u === "string") urls.push(u);
      if (u && typeof u === "object" && typeof (u as { url?: string }).url === "string") urls.push((u as { url: string }).url);
    }
  }
  return [...new Set(urls)].filter((u) => /^https?:\/\//.test(u));
}

async function api<T>(path: string, key: ProviderKey, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetchWithTimeout(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key.api_key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    timeoutMs: init?.timeoutMs ?? 30_000,
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  // بعض أخطاء kie.ai تأتي بحالة 200 لكن code != 200
  const innerCode = typeof body.code === "number" ? body.code : res.status;
  if (innerCode >= 400 || (res.status >= 400)) {
    const msg = String(body.msg ?? body.message ?? `HTTP ${res.status}`);
    throw new ProviderError(innerCode === res.status ? res.status : innerCode, msg);
  }
  return body as T;
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, model, input: TaskInput) {
    // بناء input حسب النوع (كل المميزات: نص→صورة، صورة→صورة، صوت، مدة، دقة...)
    const kieInput: Record<string, unknown> = { prompt: input.prompt };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") kieInput.aspect_ratio = input.aspect_ratio;
    if (input.type === "image") {
      if (input.resolution) kieInput.resolution = input.resolution;
      if (input.output_format) kieInput.output_format = input.output_format;
      if (input.background && input.background !== "auto") kieInput.background = input.background;
      if (input.image_url) kieInput.image_url = input.image_url; // image-to-image
    } else {
      if (input.resolution) kieInput.resolution = input.resolution;
      if (input.duration) kieInput.duration = input.duration;
      if (input.enable_audio !== undefined) kieInput.enable_audio = input.enable_audio;
      if (input.image_url) kieInput.image_url = input.image_url; // image-to-video
    }
    const body = await api<{ data: { taskId: string } }>(
      "/api/v1/jobs/createTask",
      key,
      { method: "POST", body: JSON.stringify({ model, input: kieInput }) }
    );
    const taskId = body?.data?.taskId;
    if (!taskId) throw new ProviderError(200, "لم يُعَد taskId من kie.ai");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await api<{ data: Record<string, unknown> }>(
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      key,
      { timeoutMs: 20_000 }
    );
    const data = body?.data ?? {};
    const state = String(data.state ?? "");
    const failMsg = typeof data.failMsg === "string" ? data.failMsg : "";
    const failCode = data.failCode;

    if (state === "success") {
      const urls = extractUrls(data);
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة لكن لم تُعَد روابط نتائج" };
      return { status: "completed", urls };
    }
    if (state === "fail" || failCode !== null && failCode !== undefined) {
      return { status: "failed", error: failMsg || "فشل المزود دون رسالة" };
    }
    // waiting/queuing/generating — تقدّم تقديري لأن kie لا يرسل نسبة موثوقة
    const approx = state === "generating" ? 55 : 15;
    return { status: "processing", progress: approx };
  },
};
