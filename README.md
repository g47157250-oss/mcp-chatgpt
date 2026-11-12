# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP (Model Context Protocol)** يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL:

1. **توليد صور** من نص أو صورة مرجعية — `gpt-image-2-6/flare-text-to-image` و `nano-banana-2-1`
2. **توليد فيديو بصوت متزامن أصلي** — `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع** في مقطع واحد عالي الجودة (حتى 10 مقاطع)

## الأدوات الست (MCP)

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا أو `task_id` |
| `generate_video` | توليد فيديو (حوار/مؤثرات/موسيقى) + image-to-video |
| `merge_videos` | دمج مقاطع بـ `urls` أو `task_ids` بالترتيب (2–10) |
| `get_task` | تتبع أي مهمة كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | أحدث الوسائط المخزنة بروابطها |
| `list_models` | كتالوج النماذج بكل مميزات كل نموذج |

## المزايا الجوهرية

- **تبديل مفاتيح تسلسلي صارم** بترتيب الإضافة (`created_at ASC`) — عند أي خطأ أو نفاد رصيد تُستأنف **نفس المهمة بنفس `task_id`** على المفتاح التالي فورًا ودون توقف، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد تلقائيًا مع كل `get_task` (تهدئة 45 ثانية).
- **لا تُنزَّل وسائط على السيرفر** — روابط النتائج فقط في قاعدة Turso.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`).
- تصنيف أخطاء ذكي: `disabled / exhausted / provider / params / temporary`.

## البنية التقنية

- Next.js (App Router) + TypeScript + Tailwind CSS
- `@modelcontextprotocol/sdk` — `WebStandardStreamableHTTPServerTransport` على `/mcp`
- Turso (libSQL عبر HTTP) — مناسب لـ Vercel serverless بلا ملفات محلية

## التشغيل المحلي

```bash
npm install
# أنشئ .env.local بالقيم أدناه
npm run dev
```

## متغيرات البيئة

```bash
# إلزامية
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
MERGER_API_BASE=<عنوان خدمة دمج الفيديو v2>

# اختيارية
MCP_ACCESS_TOKEN=            # إن ضُبط يُطلب Bearer token على /mcp
KIE_IMAGE_MODEL=
KIE_NANO_IMAGE_MODEL=
KIE_VIDEO_MODEL=
COMETAPI_IMAGE_MODEL=
COMETAPI_VIDEO_MODEL=
```

> **`.env*` مُستثنى من Git منذ أول commit** — لا ترفع أي سر إلى المستودع إطلاقًا.

## النشر على Vercel

1. ارفع المستودع إلى GitHub (تم).
2. في Vercel: **Add New Project → Import** المستودع.
3. أضف متغيرات البيئة الإلزامية الثلاثة (واختياريًا `MCP_ACCESS_TOKEN`).
4. Deploy — كل شيء يعمل لأن libSQL يتصل عبر HTTP ومسار `/mcp` يدعم الـ streaming.

بعد النشر استخدم `https://<your-app>.vercel.app/mcp` كـ Server URL في أي عميل MCP
(ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline).

## سجل التحديثات

### v1.3.0 — دمج الفيديوهات من الواجهة + إلغاء تسجيل الدخول
- **ميزة جديدة**: بطاقة «🎬 دمج الفيديوهات» في لوحة الإدارة — اختر مهام فيديو مكتملة بالترتيب (مع أزرار ترتيب ▲▼) أو الصق روابط مباشرة، وادمجها في فيديو واحد متصل مع متابعة التقدم حيًا عبر مسار `POST /api/merge`.
- **إصلاح**: إزالة الحماية نهائيًا من مسار `/mcp` — الربط بأي تطبيق يعمل مباشرة **بدون تسجيل دخول ولا token** (كان `MCP_ACCESS_TOKEN` يسبب مطالبة بمصادقة عند الربط).
- تحديث إعدادات الربط الجاهزة للنسخ: لم تعد تحتوي `Authorization`.
