/**
 * التسجيل المركزي للمزودين
 */
import { kieAdapter } from "./kie";
import { cometAdapter } from "./cometapi";
import type { ProviderAdapter, ProviderKey } from "./types";
import type { ProviderId } from "../models";
import { getKey, type KeyRow } from "../turso";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometAdapter,
};

export type { ProviderAdapter, ProviderKey } from "./types";

/** تحويل صف مفتاح من قاعدة البيانات إلى مفتاح مزود */
export function toProviderKey(row: KeyRow): ProviderKey {
  return { id: row.id, api_key: row.api_key, label: row.label };
}

export async function getAdapterWithKey(
  provider: ProviderId,
  keyId: string
): Promise<{ adapter: ProviderAdapter; key: ProviderKey } | null> {
  const row = await getKey(keyId);
  if (!row || row.status === "disabled") return null;
  return { adapter: PROVIDERS[provider], key: toProviderKey(row) };
}
