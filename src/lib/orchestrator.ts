/**
 * منسّق التوليد — قلب المشروع:
 * 1) تسجيل المهمة في Turso قبل أي نداء خارجي
 * 2) تجربة المرشحين بالترتيب التسلسلي الصارم مع تبديل صامت
 * 3) نافذة انتظار تبث تقدمًا حيًا، ثم task_id إن لم تكتمل
 * 4) فشل مفتاح/رصيد في منتصف المهمة → إعادة الإنشاء بنفس task_id على المفتاح التالي
 * 5) المهمة التي فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (تهدئة ~45 ثانية)
 */
import {
  insertTask, getTask, updateTask, listRecentTasks, taskStats,
  type TaskRow, type AttemptEntry,
} from "./turso";
import {
  getKeyPool, classifyProviderError, attemptEntry,
  newTaskId, cooldownElapsed, ProviderError, type ErrorClass,
} from "./keys";
import { resolveModel, MERGE_MODEL, type ProviderId, type ModelDef } from "./models";
import { PROVIDERS, toProviderKey, type ProviderAdapter, type ProviderKey } from "./providers";
import {
  createMergeJob, processMergeJob, getMergeJob, mergerConfigured,
  MERGER_LIMITS, type MergeJobStatus,
} from "./merger";

/** قفل في الذاكرة يمنع تنفيذ /process للمهمة نفسها مرتين متزامنتين */
const processInFlight = new Set<string>();

/* ================= أدوات مساعدة ================= */

export interface ToolInput {
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  resolution?: string;
  output_format?: string;
  background?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  taskId?: string;
}

function fmtTaskProcessing(task: TaskRow): string {
  return [
    `⏳ المهمة قيد المعالجة — task_id: ${task.id}`,
    `الحالة: ${task.status} (${task.progress}%)`,
    "تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
  ].join("\n");
}

function fmtCompleted(task: TaskRow): string {
  const urls: string[] = JSON.parse(task.result_urls_json || "[]");
  const head =
    task.type === "image" ? "✅ تم توليد الصورة بنجاح"
    : task.type === "merge" ? "✅ تم دمج المقاطع بنجاح"
    : "✅ تم توليد الفيديو بنجاح";
  const lines = [head];
  if (task.type === "image" && urls.length) {
    lines.push(`![image](${urls[0]})`);
    lines.push(`الرابط المباشر: ${urls[0]}`);
  } else {
    for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
  }
  if (task.type === "merge") {
    lines.push("⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  }
  return lines.join("\n");
}

function fmtFailed(task: TaskRow): string {
  // لا نذكر أبدًا أخطاء مفاتيح/رصيد للعميل — رسالة محايدة
  const internal = task.error_message || "سبب غير معروف";
  const sanitized = /insufficient|balance|credit|quota|402|401|unauthorized|api key/i.test(internal)
    ? "تعذر تنفيذ المهمة حاليًا — سيُعاد المحاولة تلقائيًا عند توفر المقدرة، أو جرّب مرة أخرى بعد قليل."
    : internal;
  return `❌ فشلت المهمة: ${sanitized}`;
}

/* ================= إنشاء مهمة توليد مع تبديل تسلسلي ================= */

interface CreateOutcome {
  provider: ProviderId;
  providerTaskId?: string;
  keyId?: string;
  syncUrls?: string[]; // للمزودات المتزامنة (صور فورية)
}

/**
 * يجرب مرشحين بالترتيب حتى أول نجاح. يحدّث عدّادات المفاتيح وسجل المحاولات دائمًا.
 * لا يُصرَّح بأي رسالة مفتاح/رصيد خارج هذا الملف.
 */
async function tryCandidates(
  task: TaskRow,
  candidates: { provider: ProviderId; key: ProviderKey; adapter: ProviderAdapter; model: string }[],
  input: ToolInput,
  mtype: "image" | "video"
): Promise<CreateOutcome> {
  let lastErrorClass: ErrorClass | undefined;
  for (const c of candidates) {
    try {
      // صور متزامنة إن دعمها المزود — تعيد الروابط فورًا
      if (mtype === "image" && c.adapter.createImageSync) {
        const { urls } = await c.adapter.createImageSync(c.key, {
          prompt: input.prompt || "", model: c.model, type: "image",
          aspect_ratio: input.aspect_ratio, resolution: input.resolution,
          output_format: input.output_format, background: input.background,
          image_url: input.image_url,
        });
        // العدّادات تُحدَّث بعد عودة tryCandidates عبر recordKeySuccess
        return { provider: c.provider, keyId: c.key.id, syncUrls: urls };
      }
      const { providerTaskId } = await c.adapter.createTask(c.key, c.model, {
        prompt: input.prompt || "", model: c.model, type: mtype,
        aspect_ratio: input.aspect_ratio, resolution: input.resolution,
        output_format: input.output_format, background: input.background,
        image_url: input.image_url, enable_audio: input.enable_audio, duration: input.duration,
      });
      return { provider: c.provider, providerTaskId, keyId: c.key.id };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, (e as Error).message);
      const cls = classifyProviderError(pe.status, pe.message);
      lastErrorClass = cls;
      // تسجيل المحاولة والعدّادات على المفتاح الفاشل
      await recordKeyFail(c.key.id, cls, pe.message);
      await updateTask(task.id, {
        append_attempt: attemptEntry(c.provider, { id: c.key.id, api_key: "", label: c.key.label } as never, false, cls, pe.message),
      });
      // params = توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
      if (cls === "params") throw pe;
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي بصمت
    }
  }
  throw new AllKeysFailedError(lastErrorClass);
}

class AllKeysFailedError extends Error {
  constructor(public lastErrorClass?: ErrorClass) {
    super("فشل الإنشاء على كل المفاتيح المتاحة");
  }
}

/** تحديث عدّادات المفتاح الفاشل — نسخة خفيفة تعمل بالمعرّف */
async function recordKeyFail(keyId: string, cls: ErrorClass, msg: string) {
  const { getKey, updateKey } = await import("./turso");
  const row = await getKey(keyId);
  if (!row) return;
  const patch: Record<string, unknown> = {
    usage_count: row.usage_count + 1,
    fail_count: row.fail_count + 1,
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    last_error: msg.slice(0, 300),
  };
  if (cls === "disabled") patch.status = "disabled";
  if (cls === "exhausted") patch.status = "exhausted";
  await updateKey(keyId, patch as never);
}

/** تحديث عدّادات المفتاح الناجح */
async function recordKeySuccess(keyId: string) {
  const { getKey, updateKey } = await import("./turso");
  const row = await getKey(keyId);
  if (!row) return;
  await updateKey(keyId, {
    usage_count: row.usage_count + 1,
    success_count: row.success_count + 1,
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  } as never);
}

/* ================= التوليد (صورة/فيديو) ================= */

export async function runGeneration(
  mtype: "image" | "video",
  input: ToolInput
): Promise<ToolResult> {
  // 1) توحيد اسم الموديل من الكتالوج
  let def: ModelDef;
  try {
    def = resolveModel(input.model || (mtype === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview"));
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
  if (def.type !== mtype) {
    return { text: `❌ النموذج ${def.canonical} مخصص لـ ${def.type === "image" ? "توليد الصور" : "توليد الفيديو"} وليس ${mtype === "image" ? "الصور" : "الفيديو"}.`, isError: true };
  }
  if (!input.prompt || !input.prompt.trim()) {
    return { text: "❌ المعطى prompt مطلوب — اكتب وصفًا للمحتوى المطلوب.", isError: true };
  }

  // 2) تجمع المفاتيح بالترتيب التسلسلي الصارم
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return {
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      isError: true,
    };
  }

  const waitSeconds = clamp(input.wait_seconds ?? (mtype === "image" ? 90 : 25), 0, 240);
  const taskId = newTaskId();

  // 3) سجل المهمة قبل أي نداء خارجي
  await insertTask({
    id: taskId,
    model: def.canonical,
    type: mtype,
    prompt: (input.prompt || "").slice(0, 2000),
    params_json: JSON.stringify(input),
    status: "processing",
  });
  const task = (await getTask(taskId))!;

  const candidates = pool.map((k) => ({
    provider: k.provider as ProviderId,
    key: toProviderKey(k),
    adapter: PROVIDERS[k.provider as ProviderId],
    model: def.providerModel[k.provider as ProviderId],
  }));

  // 4) جرّب المرشحين بالترتيب
  let outcome: CreateOutcome;
  try {
    outcome = await tryCandidates(task, candidates, input, mtype);
  } catch (e) {
    if (e instanceof ProviderError && classifyProviderError(e.status, e.message) === "params") {
      // خطأ معطيات حتمي — لا يُصلحه تبديل المفاتيح
      await updateTask(taskId, { status: "failed", error_message: e.message });
      return { text: fmtFailed({ ...task, error_message: e.message }), isError: true };
    }
    // فشل على كل المفاتيح → تبقى processing بانتظار مفتاح صالح
    await updateTask(taskId, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
    });
    return { text: fmtTaskProcessing({ ...task, status: "processing" }), taskId };
  }

  await recordKeySuccess(outcome.keyId!);
  await updateTask(taskId, {
    provider: outcome.provider,
    provider_task_id: outcome.providerTaskId, // حفظ معرّف المهمة لدى المزود للتتبع الحي
    key_id: outcome.keyId,
    append_attempt: { provider: outcome.provider, keyId: outcome.keyId!, ok: true, at: new Date().toISOString() },
  });

  // صور متزامنة → النتيجة فورًا
  if (outcome.syncUrls) {
    await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(outcome.syncUrls) });
    const done = (await getTask(taskId))!;
    return { text: fmtCompleted(done), taskId };
  }

  // 5) نافذة الانتظار مع بث تقدم حي
  const updated = await waitForProviderTask(taskId, outcome.providerTaskId!, outcome.provider, outcome.keyId!, waitSeconds, (p) =>
    updateTask(taskId, { progress: p })
  );

  if (updated.status === "completed") {
    const done = (await getTask(taskId))!;
    return { text: fmtCompleted(done), taskId };
  }
  if (updated.status === "failed") {
    // فشل معلن — فحص إن كان نمط مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
    const resumed = await maybeResumeOnNextKey(taskId, def, input, mtype);
    return resumed;
  }
  // انتهت النافذة → processing والعميل يتابع بـ get_task
  const t = (await getTask(taskId))!;
  return { text: fmtTaskProcessing(t), taskId };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** حلقة استعلام حالة المهمة لدى المزود خلال نافذة الانتظار */
async function waitForProviderTask(
  taskId: string,
  providerTaskId: string,
  provider: ProviderId,
  keyId: string,
  waitSeconds: number,
  onProgress: (p: number) => Promise<void>
): Promise<{ status: "processing" | "completed" | "failed"; error?: string }> {
  const deadline = Date.now() + waitSeconds * 1000;
  const { getAdapterWithKey } = await import("./providers");
  while (Date.now() < deadline) {
    await sleep(3000);
    const bundle = await getAdapterWithKey(provider, keyId);
    if (!bundle) {
      // المفتاح تعطّل أثناء المهمة — نُنهي النافذة ويعاد الإنشاء على المفتاح التالي عند get_task
      return { status: "processing" };
    }
    let result;
    try {
      result = await bundle.adapter.checkTask(bundle.key, providerTaskId);
    } catch {
      continue; // خطأ استعلام مؤقت → نكمل الاستعلام
    }
    if (result.status === "completed" && result.urls?.length) {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(result.urls), progress: 100 });
      return { status: "completed" };
    }
    if (result.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: result.error ?? "فشل المزود" });
      return { status: "failed", error: result.error };
    }
    if (typeof result.progress === "number") {
      await onProgress(Math.min(99, result.progress));
    }
  }
  return { status: "processing" };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** عند فشل بنمط مفتاح/رصيد: أعد الإنشاء بنفس task_id على المفتاح التالي (بصمت تمامًا) */
async function maybeResumeOnNextKey(
  taskId: string,
  def: ModelDef,
  input: ToolInput,
  mtype: "image" | "video"
): Promise<ToolResult> {
  const task = (await getTask(taskId))!;
  const pool = (await getKeyPool(def.providers)).filter((k) => k.id !== task.key_id);
  if (pool.length === 0) {
    // لا مفاتيح بديلة — تبقى processing بانتظار توفر مفتاح (لن نذكر الرصيد للعميل)
    await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: fmtTaskProcessing({ ...task, status: "processing" }), taskId };
  }
  const candidates = pool.map((k) => ({
    provider: k.provider as ProviderId,
    key: toProviderKey(k),
    adapter: PROVIDERS[k.provider as ProviderId],
    model: def.providerModel[k.provider as ProviderId],
  }));
  try {
    const outcome = await tryCandidates(task, candidates, input, mtype);
    await recordKeySuccess(outcome.keyId!);
    await updateTask(taskId, { provider: outcome.provider, provider_task_id: outcome.providerTaskId, key_id: outcome.keyId });
    if (outcome.syncUrls) {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify(outcome.syncUrls) });
      return { text: fmtCompleted((await getTask(taskId))!), taskId };
    }
    const waitSeconds = clamp(input.wait_seconds ?? (mtype === "image" ? 90 : 25), 0, 240);
    const r = await waitForProviderTask(taskId, outcome.providerTaskId!, outcome.provider, outcome.keyId!, waitSeconds, (p) =>
      updateTask(taskId, { progress: p })
    );
    if (r.status === "completed") return { text: fmtCompleted((await getTask(taskId))!), taskId };
    return { text: fmtTaskProcessing((await getTask(taskId))!), taskId };
  } catch {
    await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: fmtTaskProcessing((await getTask(taskId))!), taskId };
  }
}

/* ================= الدمج ================= */

export async function runMerge(input: { urls?: string[]; task_ids?: string[]; wait_seconds?: number }): Promise<ToolResult> {
  // 1) حل task_ids أولاً ثم urls المباشرة بنفس الترتيب
  const ordered: string[] = [];
  const failedIds: string[] = [];
  if (Array.isArray(input.task_ids)) {
    for (const tid of input.task_ids) {
      const t = await getTask(String(tid));
      if (t && t.status === "completed") {
        const urls: string[] = JSON.parse(t.result_urls_json || "[]");
        if (urls.length) ordered.push(urls[0]);
        else failedIds.push(`${tid}: مهمة مكتملة بلا روابط`);
      } else if (!t) {
        failedIds.push(`${tid}: غير موجودة`);
      } else {
        failedIds.push(`${tid}: الحالة ${t.status} (ليست مكتملة)`);
      }
    }
  }
  if (Array.isArray(input.urls)) {
    for (const u of input.urls) ordered.push(String(u));
  }

  // 2) تحقق صارم
  if (ordered.length < 2) {
    return {
      text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." +
        (failedIds.length ? `\nتفاصيل المعرّفات غير الصالحة:\n- ${failedIds.join("\n- ")}` : ""),
      isError: true,
    };
  }
  if (ordered.length > MERGER_LIMITS.maxVideos) {
    return { text: `❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).`, isError: true };
  }
  if (!ordered.every((u) => /^https?:\/\/.+/i.test(u))) {
    return { text: "❌ كل الروابط يجب أن تكون http/https مباشرة وعامة.", isError: true };
  }
  if (!mergerConfigured()) {
    return {
      text: "❌ خدمة الدمج غير مهيأة على السيرفر — اضبط متغير البيئة MERGER_API_base بالعنوان الصحيح ثم أعد المحاولة. (MERGER_API_BASE)",
      isError: true,
    };
  }

  // 3) سجل مهمة الدمج في Turso أولًا
  const taskId = newTaskId();
  await insertTask({
    id: taskId,
    model: MERGE_MODEL,
    type: "merge",
    prompt: `دمج ${ordered.length} مقاطع`,
    params_json: JSON.stringify({ videos: ordered, ...input }),
    status: "processing",
  });
  const task = (await getTask(taskId))!;

  // 4) إنشاء المهمة ثم تشغيل process خلفيًا مرة واحدة فقط (قفل في الذاكرة)
  let jobId: string;
  try {
    const j = await createMergeJob(ordered);
    jobId = j.jobId;
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError(undefined, (e as Error).message);
    if (pe.status === 0) {
      // خطأ شبكتنا — المهمة تبقى processing وتُستأنف مع get_task
      await updateTask(taskId, { provider: "merger", error_message: "بانتظار إعادة المحاولة (خطأ شبكة مؤقت)" });
      return { text: fmtTaskProcessing({ ...task, status: "processing" }), taskId };
    }
    await updateTask(taskId, { status: "failed", error_message: pe.message, provider: "merger" });
    return { text: fmtFailed({ ...task, error_message: pe.message }), isError: true };
  }

  await updateTask(taskId, { provider: "merger", provider_task_id: jobId });
  await ensureProcessStarted(jobId, taskId);

  // 5) نافذة انتظار مع بث تقدم وتحديث فوري في Turso
  const waitSeconds = clamp(input.wait_seconds ?? 60, 0, 240);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await safeMergeStatus(jobId);
    if (st?.finalError && st.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: st.error ?? "فشل الدمج" });
      return { text: fmtFailed({ ...task, error_message: st.error ?? null }), isError: true };
    }
    if (st?.status === "completed" && st.videoUrl) {
      await updateTask(taskId, { status: "completed", result_urls_json: JSON.stringify([st.videoUrl]) });
      return { text: fmtCompleted((await getTask(taskId))!), taskId };
    }
    if (st) await updateTask(taskId, { progress: Math.round(st.progress) });
  }
  return { text: fmtTaskProcessing((await getTask(taskId))!), taskId };
}

/** استعلام دفاعي لا يرمي — للخلفية وحلقة الانتظار */
async function safeMergeStatus(jobId: string): Promise<MergeJobStatus | null> {
  try { return await getMergeJob(jobId); } catch { return null; }
}

/** تشغيل /process مرة واحدة فقط لكل jobId (قفل في الذاكرة + إعادة الدخول من get_task آمنة) */
async function ensureProcessStarted(jobId: string, taskId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  (async () => {
    try {
      await processMergeJob(jobId);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, (e as Error).message);
      if (pe.status !== 0) {
        // خطأ معلن → فشل نهائي فوري (لا إعادة محاولة)
        await updateTask(taskId, { status: "failed", error_message: pe.message });
      }
      // خطأ شبكتنا → مؤقت: سيُنفَّذ process عند أول get_task
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/* ================= get_task / list_media / stats ================= */

/** تتبع أي مهمة — تحديث حي من المزود أو خدمة الدمج + منطق الاستئناف أعلاه */
export async function refreshTask(taskId: string): Promise<ToolResult> {
  const task = await getTask(taskId);
  if (!task) {
    return { text: `❌ لا توجد مهمة بالمعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لعرض أحدث المهام.`, isError: true };
  }

  if (task.status === "completed" || task.status === "failed") {
    // مهمة دمج فاشلة حتميًا؟ رسالة عربية جاهزة
    return task.status === "failed"
      ? { text: fmtFailed(task), isError: true }
      : { text: fmtCompleted(task) };
  }

  if (task.type === "merge") {
    return await refreshMergeTask(task);
  }

  // مهمة توليد جارية: إن كانت «بانتظار مفتاح صالح» أعد المحاولة بعد التهدئة
  if (task.error_message === "بانتظار توفر مفتاح صالح…") {
    if (cooldownElapsed(task)) {
      const params = JSON.parse(task.params_json || "{}") as ToolInput;
      const def = resolveModel(task.model);
      return await maybeResumeOnNextKey(task.id, def, params, task.type as "image" | "video");
    }
    return { text: fmtTaskProcessing(task) };
  }

  // تحديث حي من المزود
  if (task.provider && task.provider !== "merger" && task.provider_task_id) {
    const bundle = await getAdapterBundle(task.provider as ProviderId, task.key_id);
    if (bundle) {
      try {
        const r = await bundle.adapter.checkTask(bundle.key, task.provider_task_id);
        if (r.status === "completed" && r.urls?.length) {
          await updateTask(task.id, { status: "completed", result_urls_json: JSON.stringify(r.urls) });
          return { text: fmtCompleted((await getTask(task.id))!) };
        }
        if (r.status === "failed") {
          // فشل معلن — ربما مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
          const params = JSON.parse(task.params_json || "{}") as ToolInput;
          const def = resolveModel(task.model);
          if (/insufficient|balance|credit|quota|402|401|unauthorized|api key/i.test(r.error ?? "")) {
            return await maybeResumeOnNextKey(task.id, def, params, task.type as "image" | "video");
          }
          await updateTask(task.id, { status: "failed", error_message: r.error ?? "فشل المزود" });
          return { text: fmtFailed({ ...task, error_message: r.error ?? null }), isError: true };
        }
        if (typeof r.progress === "number") await updateTask(task.id, { progress: Math.round(r.progress) });
      } catch { /* استعلام مؤقت فاشل — نعيد الحالة الحالية */ }
    }
  }

  return { text: fmtTaskProcessing((await getTask(task.id))!), taskId };
}

async function getAdapterBundle(provider: ProviderId, keyId: string | null) {
  const { getAdapterWithKey } = await import("./providers");
  if (!keyId) return null;
  return await getAdapterWithKey(provider, keyId);
}

/** تتبع مهمة دمج — تحديث من الخدمة، وتشغيل process إن لم يُنفَّذ بعد */
async function refreshMergeTask(task: TaskRow): Promise<ToolResult> {
  if (!task.provider_task_id) {
    // لم تُنشأ لدى الخدمة بعد (خطأ شبكة عند الإنشاء) → أعد الإنشاء من params
    const params = JSON.parse(task.params_json || "{}") as { videos: string[] };
    try {
      const j = await createMergeJob(params.videos);
      await updateTask(task.id, { provider_task_id: j.jobId });
      await ensureProcessStarted(j.jobId, task.id);
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError(undefined, (e as Error).message);
      if (pe.status !== 0) {
        await updateTask(task.id, { status: "failed", error_message: pe.message });
        return { text: fmtFailed({ ...task, error_message: pe.message }), isError: true };
      }
      return { text: fmtTaskProcessing(task) };
    }
    return { text: fmtTaskProcessing((await getTask(task.id))!) };
  }

  await ensureProcessStarted(task.provider_task_id, task.id); // لا شيء إن نفُذت مسبقًا
  const st = await safeMergeStatus(task.provider_task_id);
  if (!st) return { text: fmtTaskProcessing(task) };
  if (st.finalError && st.status === "failed") {
    await updateTask(task.id, { status: "failed", error_message: st.error ?? "فشل الدمج" });
    return { text: fmtFailed({ ...task, error_message: st.error ?? null }), isError: true };
  }
  if (st.status === "completed" && st.videoUrl) {
    await updateTask(task.id, { status: "completed", result_urls_json: JSON.stringify([st.videoUrl]) });
    return { text: fmtCompleted((await getTask(task.id))!) };
  }
  if (st.status === "failed") {
    await updateTask(task.id, { status: "failed", error_message: st.error ?? "فشل الدمج" });
    return { text: fmtFailed({ ...task, error_message: st.error ?? null }), isError: true };
  }
  await updateTask(task.id, { progress: Math.round(st.progress) });
  return { text: fmtTaskProcessing((await getTask(task.id))!) };
}

/** أحدث الوسائط المخزنة بروابطها — بلا إعادة توليد */
export async function listMedia(filter: { type?: string; status?: string; limit?: number }): Promise<ToolResult> {
  const tasks = await listRecentTasks(Math.min(50, Math.max(1, filter.limit ?? 10)), {
    type: filter.type, status: filter.status,
  });
  if (!tasks.length) {
    return { text: "لا توجد مهام مخزنة بعد — تولّد صورة أو فيديو أولًا بـ generate_image / generate_video." };
  }
  const lines = [`📋 أحدث ${tasks.length} مهمة (من الأحدث):`];
  for (const t of tasks) {
    const urls: string[] = JSON.parse(t.result_urls_json || "[]");
    const label = t.type === "image" ? "🖼 صورة" : t.type === "video" ? "🎬 فيديو" : "🔗 دمج";
    lines.push(`\n${label} — ${t.model} — ${t.status}${t.type === "image" ? "" : ""} (ت: ${t.created_at})`);
    if (urls.length) for (const u of urls) lines.push(`   الرابط: ${u}`);
    else if (t.status === "failed") lines.push(`   الخطأ: ${t.error_message ?? "-"}`);
    else lines.push(`   task_id: ${t.id}`);
  }
  return { text: lines.join("\n") };
}

export async function getStats() {
  return await taskStats();
}
