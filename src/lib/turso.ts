/**
 * طبقة قاعدة البيانات — Turso عبر HTTP (libSQL client)
 * التزامن مع Vercel serverless: لا ملفات SQLite محلية إطلاقًا،
 * وكل الاتصال عبر createClient واحد مع إنشاء المخطط عند أول وصول.
 */
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Turso غير مهيأ: أضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في متغيرات البيئة"
      );
    }
    // عميل واحد يعاد استخدامه في كل الطلبات (HTTP-based، آمن للـ serverless)
    client = createClient({ url, authToken: token });
  }
  return client;
}

/** إنشاء الجداول عند أول وصول — بلا أداة migrations */
export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getTurso();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })();
  }
  return schemaReady;
}

/** فحص صحة قاعدة البيانات (SELECT 1) */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

/* ---------- أنواع الصفوف ---------- */
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/* ---------- عمليات المهام ---------- */
export interface TaskPatch {
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  status?: string;
  progress?: number;
  result_urls_json?: string;
  error_message?: string;
  append_attempt?: AttemptEntry;
}

export async function insertTask(row: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?,?,?,?,?,?,?,?,?,0)`,
    args: [
      row.id,
      row.provider ?? null,
      row.provider_task_id ?? null,
      row.key_id ?? null,
      row.model,
      row.type,
      row.prompt ?? "",
      row.params_json ?? "{}",
      row.status,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return normalizeTask(r.rows[0]);
}

function normalizeTask(row: Record<string, unknown>): TaskRow {
  // إرجاع الحقول بأنواعها الصحيحة (libSQL يعيد قيمًا مغلّفة)
  const t = row as unknown as TaskRow;
  return {
    ...t,
    progress: Number(t.progress ?? 0),
    prompt: t.prompt ?? "",
    params_json: t.params_json ?? "{}",
    attempts_json: t.attempts_json ?? "[]",
  };
}

/** تحديث جزئي للمهمة — يضيف attempts وضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number)[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.status === "completed") { sets.push("completed_at = datetime('now')"); sets.push("progress = 100"); }

  // إلحاق محاولة جديدة بسجل المحاولات
  if (patch.append_attempt) {
    const existing = await getTask(id);
    const attempts: AttemptEntry[] = existing ? JSON.parse(existing.attempts_json || "[]") : [];
    attempts.push(patch.append_attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts).slice(0, 8000)); // حد أقصى لحجم السجل
  }

  args.push(id);
  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit = 20,
  filter: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const r = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((row) => normalizeTask(row as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number; completed: number; failed: number; processing: number;
}> {
  await ensureSchema();
  const r = await getTurso().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
    FROM tasks
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/* ---------- عمليات المفاتيح ---------- */
export async function insertKey(row: {
  id: string; provider: string; label?: string; api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?,?,?,?, 'active')`,
    args: [row.id, row.provider, row.label ?? "", row.api_key],
  });
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return r.rows as unknown as KeyRow[];
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE id = ?",
    args: [id],
  });
  return r.rows.length ? (r.rows[0] as unknown as KeyRow) : null;
}

export async function updateKey(id: string, patch: Partial<KeyRow>): Promise<void> {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  const allowed: (keyof KeyRow)[] = [
    "label", "status", "usage_count", "success_count", "fail_count",
    "last_used_at", "last_checked_at", "last_error",
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k] as string | number); }
  }
  if (!sets.length) return;
  args.push(id);
  await getTurso().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}
