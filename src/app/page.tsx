/**
 * لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
 * أ) مدير المفاتيح  ب) لوحة المهام (تحديث تلقائي كل 5 ثوانٍ)  ج) ربط السيرفر
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Copy, Plus, Trash2, PowerOff, Power, RefreshCw, CheckCircle2, XCircle, Clock, ListChecks } from "lucide-react";

/* ---------- أنواع ---------- */
interface KeyItem {
  id: string; provider: string; label: string; maskedKey: string;
  status: string; usageCount: number; successCount: number; failCount: number;
  lastUsedAt: string | null; lastError: string | null; createdAt: string;
}
interface TaskItem {
  id: string; provider: string | null; model: string; type: string;
  prompt: string; status: string; progress: number; resultUrls: string[];
  errorMessage: string | null; attemptsCount: number; createdAt: string;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string; authRequired: boolean;
  merger: { base: string; healthy: boolean };
}

const PROVIDER_NAMES: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI", merger: "خدمة الدمج" };
const TOOL_CHIPS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (أو صورة مرجعية) — تُعاد جاهزة أو task_id" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي — task_id يُتابع بـ get_task" },
  { name: "merge_videos", desc: "دمج مقاطع في فيديو واحد بالترتيب (حتى 10 مقاطع، url أو task_ids)" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — صور/فيديو/دمج — كل 10 ثوانٍ" },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها من قاعدة البيانات" },
  { name: "list_models", desc: "كتالوج النماذج بكل مميزات كل نموذج لاختيار المناسب" },
];

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");
  const [form, setForm] = useState({ provider: "kie", label: "", api_key: "" });
  const [busy, setBusy] = useState(false);
  // التحديث 1.3.0 — حالة بطاقة دمج الفيديوهات
  const [mergeSel, setMergeSel] = useState<string[]>([]); // معرّفات المهام المختارة بالترتيب
  const [mergeUrls, setMergeUrls] = useState("");         // روابط مباشرة سطر لكل رابط
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<{ taskId?: string; message: string; error?: boolean } | null>(null);

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const loadHealth = useCallback(async () => {
    try { setHealth(await (await fetch("/api/health")).json()); } catch { /* تجاهل */ }
  }, []);
  const loadKeys = useCallback(async () => {
    try { setKeys((await (await fetch("/api/keys")).json()).keys); } catch { /* تجاهل */ }
  }, []);
  const loadTasks = useCallback(async () => {
    try {
      const d = await (await fetch("/api/tasks?limit=15")).json();
      setTasks(d.tasks); setStats(d.stats);
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => { loadHealth(); loadKeys(); loadTasks(); }, [loadHealth, loadKeys, loadTasks]);
  // تحديث تلقائي للمهام والصحة
  useEffect(() => {
    const t = setInterval(() => { loadTasks(); loadHealth(); loadKeys(); }, 5000);
    return () => clearInterval(t);
  }, [loadTasks, loadHealth, loadKeys]);

  async function addKey() {
    if (!form.api_key.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const d = await res.json();
      if (!res.ok) { toast({ title: "فشل الإضافة", description: d.error, variant: "destructive" }); return; }
      toast({ title: "تمت إضافة المفتاح بنجاح" });
      setForm({ provider: form.provider, label: "", api_key: "" });
      loadKeys();
    } finally { setBusy(false); }
  }

  async function toggleKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: k.status === "disabled" ? "enable" : "disable" }),
    });
    loadKeys();
  }
  async function removeKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "تم حذف المفتاح" });
    loadKeys();
  }

  // التحديث 1.3.0 — دمج الفيديوهات: روابط المهام المكتملة بالترتيب المختار + الروابط المباشرة
  const completedVideoTasks = useMemo(
    () => tasks.filter((t) => t.type === "video" && t.status === "completed" && t.resultUrls.length > 0),
    [tasks]
  );
  function toggleSelect(id: string) {
    setMergeSel((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id)
      : prev.length >= 10 ? (toast({ title: "أقصى عدد 10 مقاطع للدمج", variant: "destructive" }), prev)
      : [...prev, id]
    );
  }
  function moveSel(id: string, dir: -1 | 1) {
    setMergeSel((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]]; // ترتيب الدمج: الأول يبدأ الفيديو النهائي
      return next;
    });
  }
  async function doMerge() {
    const urls = mergeUrls.split("\n").map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
    if (mergeSel.length + urls.length < 2) {
      toast({ title: "اختر مقطعَين على الأقل (أو أدخل رابطين)", variant: "destructive" });
      return;
    }
    setMerging(true);
    setMergeResult(null);
    try {
      const res = await fetch("/api/merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_ids: mergeSel, urls, wait_seconds: 60 }),
      });
      const d = await res.json();
      setMergeResult({ taskId: d.taskId, message: d.message, error: d.isError });
      loadTasks();
      if (!d.isError) toast({ title: "بدأ الدمج — تابعه في لوحة المهام" });
    } finally { setMerging(false); }
  }

  function copy(text: string, what: string) {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: `تم نسخ ${what}` }),
      () => toast({ title: "تعذر النسخ", variant: "destructive" })
    );
  }

  const mcpUrl = `${origin}/mcp`;
  // التحديث 1.3.0: بدون حماية — لا Authorization في أي إعدادات ربط
  const chatgptJson = JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl } } }, null, 2);
  const claudeJson = JSON.stringify({ mcpServers: { "media-generator": { type: "http", url: mcpUrl } } }, null, 2);
  const cursorJson = claudeJson;

  const statusBadge = (s: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      active: { label: "نشط", cls: "bg-green-100 text-green-800" },
      exhausted: { label: "مستنزف", cls: "bg-amber-100 text-amber-800" },
      disabled: { label: "معطّل", cls: "bg-gray-100 text-gray-600" },
      completed: { label: "مكتملة", cls: "bg-green-100 text-green-800" },
      processing: { label: "جارية", cls: "bg-blue-100 text-blue-800" },
      failed: { label: "فاشلة", cls: "bg-red-100 text-red-800" },
    };
    const v = map[s] ?? { label: s, cls: "bg-gray-100 text-gray-600" };
    return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${v.cls}`}>{v.label}</span>;
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-slate-100">
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">MCP Media Generator</h1>
            <p className="text-sm text-muted-foreground">خادم توليد الصور والفيديو ودمج المقاطع — لوحة الإدارة</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {health ? (
              health.ok ? (
                <Badge className="bg-green-600">✅ Turso متصل</Badge>
              ) : (
                <Badge variant="destructive">❌ غير متصل</Badge>
              )
            ) : (
              <Badge variant="secondary">جارٍ الفحص…</Badge>
            )}
            {health && (
              <Badge variant={health.merger.healthy ? "default" : "outline"}>
                {health.merger.healthy ? "خدمة الدمج جاهزة" : "خدمة الدمج غير مهيأة"}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 space-y-6">

        {/* أ) مدير المفاتيح */}
        <Card>
          <CardHeader>
            <CardTitle>🔑 مدير المفاتيح</CardTitle>
            <p className="text-sm text-muted-foreground">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div>
                <Label>المزود</Label>
                <select
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                >
                  <option value="kie">kie.ai</option>
                  <option value="cometapi">CometAPI</option>
                </select>
              </div>
              <div>
                <Label>تسمية (اختياري)</Label>
                <Input className="mt-1" placeholder="مثال: حساب رئيسي" value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Label>المفتاح</Label>
                <div className="flex gap-2 mt-1">
                  <Input placeholder="لصق المفتاح هنا" value={form.api_key} dir="ltr"
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
                  <Button onClick={addKey} disabled={busy}>
                    <Plus className="size-4 me-1" /> إضافة
                  </Button>
                </div>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto space-y-2">
              {keys.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">لا توجد مفاتيح بعد — أضف أول مفتاح أعلاه.</p>
              )}
              {keys.map((k) => (
                <div key={k.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 bg-white">
                  <Badge variant="outline">{PROVIDER_NAMES[k.provider] ?? k.provider}</Badge>
                  <code className="text-xs bg-slate-100 rounded px-2 py-1" dir="ltr">{k.maskedKey}</code>
                  {statusBadge(k.status)}
                  {k.label && <span className="text-sm font-medium">{k.label}</span>}
                  <span className="text-xs text-muted-foreground">
                    استخدام {k.usageCount} · نجاح {k.successCount} · فشل {k.failCount}
                  </span>
                  {k.lastError && (
                    <span className="text-xs text-red-600 truncate max-w-64" dir="ltr" title={k.lastError}>
                      آخر خطأ: {k.lastError}
                    </span>
                  )}
                  <div className="ms-auto flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => toggleKey(k)} title={k.status === "disabled" ? "تنشيط" : "تعطيل"}>
                      {k.status === "disabled" ? <Power className="size-4" /> : <PowerOff className="size-4" />}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => removeKey(k)} title="حذف">
                      <Trash2 className="size-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ب) لوحة المهام */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              🗂 لوحة المهام
              <RefreshCw className="size-4 text-muted-foreground animate-[spin_2s_linear_infinite]" />
              <span className="text-xs font-normal text-muted-foreground">تتحدث تلقائيًا كل 5 ثوانٍ</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "الإجمالي", v: stats.total, icon: ListChecks, cls: "text-slate-700" },
                { label: "مكتملة", v: stats.completed, icon: CheckCircle2, cls: "text-green-600" },
                { label: "جارية", v: stats.processing, icon: Clock, cls: "text-blue-600" },
                { label: "فاشلة", v: stats.failed, icon: XCircle, cls: "text-red-600" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-white p-3 text-center">
                  <s.icon className={`size-5 mx-auto ${s.cls}`} />
                  <div className="text-2xl font-bold mt-1">{s.v}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="max-h-96 overflow-y-auto space-y-2">
              {tasks.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">لا توجد مهام بعد.</p>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="rounded-lg border p-3 bg-white space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {statusBadge(t.status)}
                    <Badge variant="outline">
                      {t.type === "image" ? "🖼 صورة" : t.type === "video" ? "🎬 فيديو" : "🔗 دمج"}
                    </Badge>
                    <code className="text-xs text-muted-foreground" dir="ltr">{t.model}</code>
                    {t.provider && <Badge variant="secondary">{PROVIDER_NAMES[t.provider] ?? t.provider}</Badge>}
                    {t.attemptsCount > 0 && <span className="text-xs text-muted-foreground">محاولات: {t.attemptsCount}</span>}
                    <span className="text-xs text-muted-foreground ms-auto">{t.createdAt.replace("T", " ").slice(0, 19)}</span>
                  </div>
                  {t.prompt && <p className="text-sm text-muted-foreground truncate">{t.prompt}</p>}
                  {t.status === "processing" && <Progress value={t.progress} className="h-2" />}
                  {t.status === "completed" && t.resultUrls.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {t.resultUrls.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer"
                          className="text-xs text-primary underline truncate max-w-md" dir="ltr">{u}</a>
                      ))}
                    </div>
                  )}
                  {t.status === "failed" && t.errorMessage && (
                    <p className="text-xs text-red-600">{t.errorMessage}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <code className="text-[10px] text-muted-foreground" dir="ltr">task: {t.id}</code>
                    <button className="text-[10px] text-primary underline" onClick={() => copy(t.id, "المعرّف")}>نسخ</button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ج) دمج الفيديوهات — التحديث 1.3.0 */}
        <Card>
          <CardHeader>
            <CardTitle>🎬 دمج الفيديوهات في فيديو واحد متصل</CardTitle>
            <p className="text-sm text-muted-foreground">
              اختر مهام فيديو مكتملة بالترتيب الذي تريده (أول مقطع يبدأ الفيديو النهائي)، أو الصق روابط مباشرة — يُدمج كل شيء في مقطع واحد متصل بالترتيب نفسه.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-semibold mb-2">
                المقاطع المكتملة المتاحة {mergeSel.length > 0 && <span className="text-primary">(مختار بالترتيب: {mergeSel.length})</span>}
              </p>
              <div className="max-h-56 overflow-y-auto space-y-2">
                {completedVideoTasks.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2 text-center">
                    لا توجد فيديوهات مكتملة بعد — ولّد فيديوهات أولًا أو استخدم روابط مباشرة أدناه.
                  </p>
                )}
                {completedVideoTasks.map((t) => {
                  const idx = mergeSel.indexOf(t.id);
                  return (
                    <label key={t.id} className={`flex items-center gap-2 rounded-lg border p-2.5 bg-white cursor-pointer ${idx >= 0 ? "border-primary" : ""}`}>
                      <input type="checkbox" checked={idx >= 0} onChange={() => toggleSelect(t.id)} className="size-4" />
                      <span className="text-xs text-muted-foreground" dir="ltr">{t.id.slice(0, 8)}…</span>
                      <span className="text-sm truncate flex-1">{t.prompt || t.model}</span>
                      {idx >= 0 && (
                        <span className="flex items-center gap-1">
                          <Badge className="bg-primary text-primary-foreground">#{idx + 1}</Badge>
                          <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); moveSel(t.id, -1); }} title="أعلى">▲</Button>
                          <Button size="sm" variant="ghost" onClick={(e) => { e.preventDefault(); moveSel(t.id, 1); }} title="أسفل">▼</Button>
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>روابط مباشرة (سطر لكل رابط — تُدمج بعد المقاطع المختارة)</Label>
              <textarea
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-20"
                dir="ltr" placeholder={"https://example.com/clip1.mp4\nhttps://example.com/clip2.mp4"}
                value={mergeUrls} onChange={(e) => setMergeUrls(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button onClick={doMerge} disabled={merging}>
                {merging ? "جارٍ بدء الدمج…" : "🔗 دمج المقاطع في فيديو واحد"}
              </Button>
              {mergeSel.length + mergeUrls.split("\n").filter((u) => /^https?:\/\//.test(u.trim())).length > 10 && (
                <span className="text-xs text-red-600">تجاوزت 10 مقاطع — سيرفض السيرفر الطلب.</span>
              )}
            </div>

            {mergeResult && (
              <div className={`rounded-lg border p-3 text-sm whitespace-pre-wrap ${mergeResult.error ? "border-red-300 bg-red-50 text-red-800" : "border-green-300 bg-green-50 text-green-900"}`}>
                {mergeResult.message}
                {mergeResult.taskId && (
                  <span className="block mt-1 text-xs" dir="ltr">task_id: {mergeResult.taskId}</span>
                )}
              </div>
            )}

            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              ⚠️ ملف الدمج النهائي يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا. لا حاجة لأي تسجيل دخول: الربط والدمج يعملان مباشرة.
            </div>
          </CardContent>
        </Card>

        {/* د) ربط السيرفر */}
        <Card>
          <CardHeader>
            <CardTitle>🔗 ربط السيرفر بأي عميل MCP</CardTitle>
            <div className="flex items-center gap-2 mt-2">
              <code className="flex-1 rounded bg-slate-100 px-3 py-2 text-sm overflow-x-auto" dir="ltr">{mcpUrl}</code>
              <Button variant="outline" onClick={() => copy(mcpUrl, "الرابط")}>
                <Copy className="size-4 me-1" /> نسخ
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs defaultValue="chatgpt">
              <TabsList>
                <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  في ChatGPT: Settings → Connectors → Create → Custom MCP server وضَع الرابط في «Server URL».
                </p>
                <pre className="rounded-lg bg-slate-900 text-slate-100 p-3 text-xs overflow-x-auto" dir="ltr">{chatgptJson}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(chatgptJson, "الإعدادات")}>
                  <Copy className="size-4 me-1" /> نسخ JSON
                </Button>
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-sm text-muted-foreground">أضِف إلى ملف claude_desktop_config.json.</p>
                <pre className="rounded-lg bg-slate-900 text-slate-100 p-3 text-xs overflow-x-auto" dir="ltr">{claudeJson}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(claudeJson, "الإعدادات")}>
                  <Copy className="size-4 me-1" /> نسخ JSON
                </Button>
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-sm text-muted-foreground">أضِف إلى mcp.json في Cursor / Windsurf / Cline.</p>
                <pre className="rounded-lg bg-slate-900 text-slate-100 p-3 text-xs overflow-x-auto" dir="ltr">{cursorJson}</pre>
                <Button variant="outline" size="sm" onClick={() => copy(cursorJson, "الإعدادات")}>
                  <Copy className="size-4 me-1" /> نسخ JSON
                </Button>
              </TabsContent>
            </Tabs>

            <div>
              <p className="text-sm font-semibold mb-2">الأدوات المتاحة (6):</p>
              <div className="flex flex-wrap gap-2">
                {TOOL_CHIPS.map((t) => (
                  <div key={t.name} className="rounded-full border bg-white px-3 py-1.5 text-xs max-w-full">
                    <code className="font-bold" dir="ltr">{t.name}</code>
                    <span className="text-muted-foreground"> — {t.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-muted-foreground">
              🔒 كل المفاتيح مخفية دائمًا في الواجهة وفي كل الاستجابات (مقنّعة)، ولا تُخزَّن أي وسائط على السيرفر — روابط النتائج فقط في قاعدة Turso.
            </div>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t bg-white">
        <div className="max-w-6xl mx-auto px-4 py-3 text-xs text-muted-foreground text-center">
          MCP Media Generator v1.2.0 — توليد الصور والفيديو ودمج المقاطع عبر MCP
        </div>
      </footer>
    </div>
  );
}
