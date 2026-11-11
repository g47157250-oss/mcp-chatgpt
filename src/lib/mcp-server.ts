/**
 * خادم MCP — يجمع الأدوات ويضبط النصوص العربية للردود.
 * يستخدم SDK الرسمي: McpServer + StreamableHTTPServerTransport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MODELS } from "@/lib/models";
import {
  runGeneration, runMerge, refreshTask, listMedia,
  type ToolResult, type ToolInput,
} from "@/lib/orchestrator";
import { MERGER_LIMITS } from "@/lib/merger";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database. Use list_models to browse the model catalog and pick the right model for the user's request.`;

/** تحويل نتيجة الأداة إلى شكل MCP */
function tr(r: ToolResult) {
  return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
}

/** تسجيل الأدوات الست على السيرفر */
export function registerTools(server: McpServer): void {
  /* 1) generate_image */
  server.tool(
    "generate_image",
    `Generate an image with gpt-image-2-6/flare-text-to-image (also nano-banana-2-1 available) with automatic sequential failover across all active API keys. Returns the finished image URL if completed within the wait window; otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.`,
    {
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image", "nano-banana-2-1"]).default("gpt-image-2-6/flare-text-to-image").describe("Image model — see list_models"),
      image_url: z.string().optional().describe("Optional public image URL as reference (image-to-image)."),
      aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    },
    async (args) => tr(await runGeneration("image", args as ToolInput))
  );

  /* 2) generate_video */
  server.tool(
    "generate_video",
    `Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Videos take minutes: short wait with live progress streaming, then a task_id — poll get_task every ~10 seconds.`,
    {
      prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    },
    async (args) => tr(await runGeneration("video", args as ToolInput))
  );

  /* 3) merge_videos */
  server.tool(
    "merge_videos",
    `Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs) or 'task_ids' (completed video tasks, resolved in order — ideal after generating several clips). Usually fast: short wait with progress streaming, then a merge task_id — track it with get_task. IMPORTANT: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly. Max ${MERGER_LIMITS.maxVideos} clips.`,
    {
      // التحقق من العدد (≥2 و ≤10) يتم في runMerge برسائل عربية — لا حد هنا ليصعد الخطأ العربي
      urls: z.array(z.string()).optional()
        .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. 2–10 clips."),
      task_ids: z.array(z.string()).optional()
        .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. 2–10 ids."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    },
    async (args) => tr(await runMerge(args))
  );

  /* 4) get_task */
  server.tool(
    "get_task",
    `Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/service while processing). Poll every ~10 seconds; when completed you'll find result URLs — show them to the user and stop polling.`,
    { task_id: z.string().describe("The task_id returned by generate_image/generate_video/merge_videos.") },
    async ({ task_id }) => tr(await refreshTask(task_id))
  );

  /* 5) list_media */
  server.tool(
    "list_media",
    `List the latest stored images/videos/merges with their URLs from the database (no regeneration) — to recall previous results.`,
    {
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (args) => tr(await listMedia(args))
  );

  /* 6) list_models — كتالوج النماذج بكل المميزات */
  server.tool(
    "list_models",
    `Browse the model catalog: all supported generation models with their FULL capabilities (modes, aspect ratios, resolutions, formats, audio, duration) so you can pick the right model based on the user's request.`,
    {},
    async () => {
      const catalog = MODELS.map((m) => ({
        model: m.canonical,
        aliases: m.aliases,
        type: m.type,
        providers: m.providers,
        capabilities: m.features,
      }));
      const text =
        "📋 كتالوج النماذج المتاحة في هذا السيرفر:\n\n" +
        MODELS.map((m) => {
          const f = m.features;
          return [
            `• ${m.canonical} (${m.type === "image" ? "توليد صور" : "توليد فيديو"}) — المزودات: ${m.providers.join("، ")}`,
            `  المميزات: ${f.modes.join(" + ")}`,
            f.aspectRatios ? `  نسب الأبعاد: ${f.aspectRatios.join(", ")}` : "",
            f.resolutions ? `  الدقة: ${f.resolutions.join(", ")}` : "",
            f.formats ? `  الصيغ: ${f.formats.join(", ")}` : "",
            f.backgrounds ? `  الخلفية: ${f.backgrounds.join(", ")}` : "",
            f.audio ? `  صوت أصلي متزامن: نعم` : "",
            f.maxDurationSeconds ? `  المدة: حتى ${f.maxDurationSeconds} ثانية` : "",
            `  ${f.notes}`,
          ].filter(Boolean).join("\n");
        }).join("\n\n") +
        "\n\nJSON:\n" + JSON.stringify(catalog, null, 2);
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
