/**
 * مسار خادم MCP — Streamable HTTP حسب مواصفة MCP
 * يستخدم WebStandardStreamableHTTPServerTransport الرسمي (مصمم لبيئات الويب مثل Next.js):
 * POST = رسائل JSON-RPC، DELETE = إنهاء الجلسة.
 */
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS, registerTools } from "@/lib/mcp-server";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** جلسات نشطة في الذاكرة (serverless: تُستبدل بجلسة جديدة تلقائيًا عند فقدانها) */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

// التحديث 1.3.0: إزالة الحماية نهائيًا — الـ MCP يعمل مفتوحًا بدون تسجيل دخول ولا توكن،
// حتى لا يطلب أي تطبيق (ChatGPT/Claude/Cursor) مصادقة عند الربط.

/** إنشاء سيرفر + transport جديد وربطهما وتسجيل الجلسة */
function createSession(): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => { if (sid) sessions.set(sid, transport); },
    onsessionclosed: (sid) => { if (sid) sessions.delete(sid); },
    enableJsonResponse: false, // ندفق SSE عند وجود progress notifications
  });
  void server.connect(transport);
  return { server, transport };
}

export async function POST(req: NextRequest) {
  await ensureSchema().catch(() => { /* يُفحص داخل الأدوات أيضًا */ });

  // إعادة استخدام الجلسة الموجودة؛ إن ضاعت (serverless إعادة تشغيل) نطلب من العميل إعادة التهيئة
  const sid = req.headers.get("mcp-session-id");
  let transport = sid ? sessions.get(sid) : undefined;
  if (sid && !transport) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session expired — please re-initialize (جلسة منتهية، أعد التهيئة)" },
    }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  if (!transport) {
    // لا معرّف جلسة = تهيئة جديدة (initialize)
    transport = createSession().transport;
  }
  try {
    return await transport.handleRequest(req as unknown as Request);
  } catch (e) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function DELETE(req: NextRequest) {
  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    const t = sessions.get(sid);
    if (t) {
      try { await t.close(); } catch { /* تجاهل */ }
      sessions.delete(sid);
    }
  }
  return new Response(null, { status: 204 });
}

export async function GET(req: NextRequest) {
  // دعم قناة الاستماع SSE للجلسات القائمة (اختياري حسب المواصفة)
  const sid = req.headers.get("mcp-session-id");
  const t = sid ? sessions.get(sid) : undefined;
  if (!t) {
    return new Response(JSON.stringify({ error: "جلسة غير موجودة — أعد التهيئة بـ initialize" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }
  return await t.handleRequest(req as unknown as Request);
}
