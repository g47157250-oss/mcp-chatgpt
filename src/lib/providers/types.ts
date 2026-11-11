/**
 * واجهة موحدة للمزودين — أي خطأ يُرمى كـ ProviderError ليُصنَّف في keys.ts
 */
import { ProviderError } from "../keys";
import type { ProviderId } from "../models";

export interface ProviderKey {
  id: string;
  api_key: string;
  label: string;
}

export interface TaskInput {
  prompt: string;
  model: string; // providerModel الخاص بالمزود
  type: "image" | "video";
  aspect_ratio?: string;
  resolution?: string;
  output_format?: string;
  background?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  createTask(key: ProviderKey, model: string, input: TaskInput): Promise<{ providerTaskId: string }>;
  createImageSync?(key: ProviderKey, input: TaskInput): Promise<{ urls: string[] }>;
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckResult>;
}

/** fetch بمهلة زمنية — تحويل انقطاع الشبكة/timeout إلى ProviderError مؤقت */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    return res;
  } catch (e) {
    // انقطاع شبكة/مهلة → مؤقت (يفحصه classifyProviderError كـ temporary)
    throw new ProviderError(0, `network: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}
