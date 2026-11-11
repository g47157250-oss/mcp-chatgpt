/**
 * طبقة المفاتيح — الترتيب تسلسلي صارم بترتيب الإضافة (لا round-robin)
 * وتصنيف أخطاء المزودين وتبديل فوري دون توقف المهمة.
 */
import { v4 as uuidv4 } from "uuid";
import {
  listKeys, updateKey, type KeyRow, type AttemptEntry, type TaskRow,
} from "./turso";
import type { ProviderId } from "./models";

/** إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات */
export function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "••••" + key.slice(-2);
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

export function keyPublic(row: KeyRow) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    maskedKey: maskKey(row.api_key),
    status: row.status,
    usageCount: row.usage_count,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** تصنيف موحد لأخطاء المزودين — نفحص نفاد الرصيد قبل 400 لأن بعض المزودين يرسله بحالة 400 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) {
    return "disabled";
  }
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值|余额/.test(m)
  ) {
    return "exhausted";
  }
  if (/model not found|unsupported model|not supported/.test(m) && [400, 404, 422].includes(status ?? 0)) {
    return "provider";
  }
  if ([400, 422].includes(status ?? 0)) return "params";
  return "temporary"; // 429، 5xx، شبكة، timeout
}

export class ProviderError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
  }
}

/**
 * تجلب المرشحين للمزودات المطلوبة بالترتيب الصارم:
 * ORDER BY created_at ASC, id ASC — أول مفتاح أُضيف يُجرَّب أولًا.
 * المفتاح المستنزف يبقى في القائمة (يُستثنى فقط التعطيل اليدوي disabled).
 */
export async function getKeyPool(providers: ProviderId[]): Promise<KeyRow[]> {
  const all = await listKeys();
  const wanted = new Set(providers);
  return all.filter((k) => wanted.has(k.provider as ProviderId) && k.status !== "disabled");
}

/** تسجيل نتيجة محاولة: تحديث عدّادات المفتاح + حالة المفتاح حسب الفئة */
export async function recordAttempt(
  key: KeyRow,
  ok: boolean,
  errorClass?: ErrorClass,
  errorMessage?: string
): Promise<void> {
  const patch: Partial<KeyRow> = {
    usage_count: (key.usage_count ?? 0) + 1,
    success_count: (key.success_count ?? 0) + (ok ? 1 : 0),
    fail_count: (key.fail_count ?? 0) + (ok ? 0 : 1),
    last_used_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  };
  if (!ok) {
    patch.last_error = (errorMessage || "unknown").slice(0, 300);
    if (errorClass === "disabled") patch.status = "disabled";   // مفتاح مرفوض → تعطيل تلقائي
    if (errorClass === "exhausted") patch.status = "exhausted"; // رصيد منتهٍ → يبقى في القاعدة
  }
  await updateKey(key.id, patch);
}

export function attemptEntry(
  provider: string, key: KeyRow, ok: boolean, errorClass?: ErrorClass, errorMessage?: string
): AttemptEntry {
  return {
    provider,
    keyId: key.id,
    keyLabel: key.label || maskKey(key.api_key),
    ok,
    errorClass,
    error: errorMessage?.slice(0, 200),
    at: new Date().toISOString(),
  };
}

/** فترة تهدئة قبل إعادة المحاولة التلقائية على مهام «بانتظار مفتاح صالح» */
export const KEY_RETRY_COOLDOWN_MS = 45_000;

/** هل انتهت التهدئة؟ نستخدم updated_at كساعة آخر محاولة إنشاء */
export function cooldownElapsed(task: TaskRow): boolean {
  const last = new Date(task.updated_at + "Z").getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= KEY_RETRY_COOLDOWN_MS;
}

export function newTaskId(): string {
  return uuidv4();
}
