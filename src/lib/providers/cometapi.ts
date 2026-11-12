/**
 * مزود CometAPI — صور متزامنة عبر نقطة متوافقة مع OpenAI، وفيديو عبر مهام غير متزامنة
 * بنمط create/check. أي تغيير في التوثيق الرسمي يُعتمد على الشكل الحقيقي.
 */
import { ProviderError } from "../keys";
import { fetchWithTimeout, type ProviderAdapter, type ProviderKey, type TaskInput, type CheckResult } from "./types";

const BASE = "https://api.cometapi.com";

async function api<T>(path: string, key: ProviderKey, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetchWithTimeout(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key.api_key}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    timeoutMs: init?.timeoutMs ?? 45_000,
  });
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم غير JSON */ }
  const errMsg =
    (body?.error && typeof body.error === "object" && "message" in body.error
      ? String((body.error as { message?: unknown }).message)
      : typeof body?.error === "string" ? body.error : undefined)
    ?? (typeof body?.message === "string" ? body.message : undefined)
    ?? `HTTP ${res.status}`;
  if (res.status >= 400 || body?.error) {
    throw new ProviderError(res.status, errMsg);
  }
  return body as T;
}

export const cometAdapter: ProviderAdapter = {
  id: "cometapi",

  /** صور متزامنة — تُعاد الروابط فورًا (b64_json يُرفض: لا ننزّل وسائط، نطلب الروابط فقط) */
  async createImageSync(key, input: TaskInput) {
    const body = await api<{ data?: Array<{ url?: string }> }>(
      "/v1/images/generations",
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          n: 1,
          size: input.aspect_ratio === "9:16" ? "1024x1792"
            : input.aspect_ratio === "3:2" || input.aspect_ratio === "16:9" ? "1792x1024"
            : "1024x1024",
          response_format: "url", // روابط فقط — لا تنزيل أي وسائط على سيرفرنا
        }),
        timeoutMs: 120_000,
      }
    );
    const urls = (body?.data ?? [])
      .map((d) => d.url)
      .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
    if (!urls.length) throw new ProviderError(200, "لم تُعَد روابط صور من CometAPI");
    return { urls };
  },

  async createTask(key, model, input: TaskInput) {
    // فيديو: نقطة مهام بنمط create/check — الشكل المحافظ الأقرب للتوثيق
    const payload: Record<string, unknown> = { model, prompt: input.prompt };
    if (input.image_url) payload.image_url = input.image_url;
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution) payload.resolution = input.resolution;
    if (input.duration) payload.duration = input.duration;
    if (input.enable_audio !== undefined) payload.enable_audio = input.enable_audio;
    const body = await api<{ id?: string; data?: { taskId?: string; id?: string } }>(
      "/v1/video/tasks",
      key,
      { method: "POST", body: JSON.stringify(payload) }
    );
    const taskId = body?.data?.taskId ?? body?.data?.id ?? (body as { id?: string })?.id;
    if (!taskId) throw new ProviderError(200, "لم يُعَد معرّف مهمة من CometAPI");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await api<Record<string, unknown>>(
      `/v1/video/tasks/${encodeURIComponent(providerTaskId)}`,
      key,
      { timeoutMs: 20_000 }
    );
    const data = (body?.data ?? body) as Record<string, unknown>;
    const st = String(data.status ?? data.state ?? "").toLowerCase();
    if (["succeeded", "success", "completed", "complete", "done"].includes(st)) {
      const raw = data.resultUrls ?? data.videoUrl ?? data.url;
      const urls: string[] = [];
      if (typeof raw === "string" && /^https?:\/\//.test(raw)) urls.push(raw);
      if (Array.isArray(raw)) for (const u of raw) if (typeof u === "string") urls.push(u);
      if (typeof raw === "string" && raw.startsWith("{")) {
        try {
          const p = JSON.parse(raw);
          if (Array.isArray(p?.resultUrls)) urls.push(...(p.resultUrls as string[]).filter((u) => typeof u === "string"));
        } catch { /* تجاهل */ }
      }
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة لكن لا روابط نتائج" };
      return { status: "completed", urls };
    }
    if (["failed", "error", "cancelled"].includes(st)) {
      return { status: "failed", error: String(data.error ?? data.failMsg ?? "فشل المزود") };
    }
    return { status: "processing", progress: 40 };
  },
};
