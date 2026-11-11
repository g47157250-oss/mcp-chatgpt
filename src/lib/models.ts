/**
 * سجل الموديلات (الكتالوج) — النماذج المطلوبة فقط:
 * صور: nano-banana-2-1 و gpt-image-2-6/flare-text-to-image
 * فيديو: grok-imagine-video-1-5-preview
 * إضافة نماذج جديدة مستقبلًا = إضافة مدخل واحد هنا فقط.
 */
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
  /** الكتالوج: كل المميزات المتاحة للنموذج (تُعرض في list_models) */
  features: {
    modes: string[];              // text-to-image / image-to-image / text-to-video / image-to-video
    aspectRatios?: string[];
    resolutions?: string[];
    formats?: string[];
    backgrounds?: string[];
    maxDurationSeconds?: number;
    audio?: boolean;
    notes: string;                // وصف عربي موجز
  };
}

/** تجاوز الأسماء عبر متغيرات البيئة إن لزم */
function kieImg(): string { return process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image"; }
function kieImgNano(): string { return process.env.KIE_NANO_IMAGE_MODEL || "nano-banana-2-1"; }
function kieVid(): string { return process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview"; }
function cometImg(): string { return process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image"; }
function cometVid(): string { return process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview"; }

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6/flare", "gpt-image-2.6/flare"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: kieImg(), cometapi: cometImg() },
    features: {
      modes: ["text-to-image", "image-to-image"],
      aspectRatios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"],
      resolutions: ["1K", "2K", "4K"],
      formats: ["png", "jpeg", "webp", "gif"],
      backgrounds: ["auto", "transparent", "opaque"],
      notes: "توليد صور عالي الجودة من نص أو من صورة مرجعية (image_url) مع خلفية شفافة ودقة حتى 4K.",
    },
  },
  {
    canonical: "nano-banana-2-1",
    aliases: ["nano-banana-2.1", "nano-banana", "google/nano-banana"],
    type: "image",
    providers: ["kie"],
    providerModel: { kie: kieImgNano(), cometapi: "nano-banana-2-1" },
    features: {
      modes: ["text-to-image", "image-to-image"],
      aspectRatios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
      resolutions: ["1K", "2K"],
      formats: ["png", "jpeg", "webp"],
      notes: "نموذج Nano Banana السريع: تحرير ودمج صور مرجعية، ثبات ممتاز للشخصيات، نتائج فورية تقريبًا.",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: kieVid(), cometapi: cometVid() },
    features: {
      modes: ["text-to-video", "image-to-video"],
      aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"],
      resolutions: ["480p", "720p", "1080p"],
      maxDurationSeconds: 15,
      audio: true,
      notes: "فيديو مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) — يدعم image-to-video باختيار أول إطار من صورة.",
    },
  },
];

const ALIAS_MAP = new Map<string, ModelDef>();
for (const m of MODELS) {
  ALIAS_MAP.set(m.canonical, m);
  for (const a of m.aliases) ALIAS_MAP.set(a, m);
}

/** توحيد اسم الموديل (شرطات/نقاط) والبحث في الكتالوج — يرمي خطأ معطيات إن غير معروف */
export function resolveModel(name?: string): ModelDef {
  if (!name) throw new ModelError("model مطلوب — استخدم list_models لعرض الكتالوج");
  const candidates = [name, name.replace(/\./g, "-"), name.replace(/\//g, "-"), name.replace(/[.\-_]/g, "").toLowerCase()];
  for (const c of candidates) {
    const hit = ALIAS_MAP.get(c) ?? ALIAS_MAP.get(c.toLowerCase());
    if (hit) return hit;
  }
  // بحث نهائي بدون فواصل (شرطة/نقطة/شرطة مائلة)
  const flat = name.replace(/[.\-_/]/g, "").toLowerCase();
  for (const [k, v] of ALIAS_MAP) {
    if (k.replace(/[.\-_/]/g, "").toLowerCase() === flat) return v;
  }
  throw new ModelError(
    `❌ نموذج غير معروف: ${name}. المتاح: ${MODELS.map((m) => m.canonical).join(" ، ")}. استخدم list_models للكتالوج الكامل.`
  );
}

export class ModelError extends Error {}

/** نماذج مدمجة خاصة */
export const MERGE_MODEL = "video-merger";
