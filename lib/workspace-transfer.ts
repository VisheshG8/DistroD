import { normalizeColumns, normalizeOverrides } from './display';
import { normalizeScope, type Scope } from './scope';

export const TRANSFER_CHUNK_BYTES = 524288;
export const MAX_BACKUP_BYTES = 104857600;
export type TransferMap = { source: string; target: string; isNew: boolean }[];
export type TransferSummary = {
  collections: number; pages: number; posts: number; collectionsToAdd: number; pagesToAdd: number;
  existingCollections: number; existingPages: number; membershipsToAdd: number;
  collectionNames: string[]; exportedAt: string | null;
  historyPosts?: number; accountSnapshots?: number; postSnapshots?: number; alerts?: number;
};
export type TransferResult = { ok: boolean; summary: TransferSummary; pageMap: TransferMap; collectionMap: TransferMap; preferences: unknown };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function read(storage: StorageLike, key: string) { try { return object(JSON.parse(storage.getItem(key) || '{}')); } catch { return {}; } }

export function collectWorkspacePreferences(storage: StorageLike, owner: string) {
  const presentation = read(storage, `distribution-desk:presentation:v1:${owner}`);
  const scopes: Record<string, Scope> = {}, prefix = `distribution-desk:scope:${owner}:`;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try { scopes[key.slice(prefix.length)] = normalizeScope(JSON.parse(storage.getItem(key) || 'null')); } catch { /* Ignore corrupt local preferences. */ }
  }
  return { columns: normalizeColumns(presentation.columns), overrides: normalizeOverrides(presentation.overrides), scopes };
}

/** Restore only known preference fields, remapping source IDs to this login. */
export function restoreWorkspacePreferences(storage: StorageLike, owner: string, result: TransferResult, overwrite: boolean) {
  const incoming = object(result.preferences), pageMap = new Map(result.pageMap.map(item => [item.source, item.target]));
  const collectionMap = new Map(result.collectionMap.map(item => [item.source, item.target]));
  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(normalizeOverrides(incoming.overrides))) {
    const [source, scope, metric] = JSON.parse(key) as string[], target = pageMap.get(source);
    if (target) overrides[JSON.stringify([target, scope, metric])] = value;
  }
  const presentationKey = `distribution-desk:presentation:v1:${owner}`, current = read(storage, presentationKey);
  const existing = normalizeOverrides(current.overrides);
  storage.setItem(presentationKey, JSON.stringify({
    columns: normalizeColumns(overwrite || !storage.getItem(presentationKey) ? incoming.columns : current.columns),
    overrides: overwrite ? { ...existing, ...overrides } : { ...overrides, ...existing },
  }));
  for (const [source, value] of Object.entries(object(incoming.scopes))) {
    const target = source === 'all' ? 'all' : collectionMap.get(source);
    if (!target) continue;
    let scope: Scope; try { scope = normalizeScope(value); } catch { continue; }
    const key = `distribution-desk:scope:${owner}:${target}`;
    if (overwrite || !storage.getItem(key)) storage.setItem(key, JSON.stringify(scope));
  }
}

export function bytesToBase64(bytes: Uint8Array) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}
export function base64ToBytes(value: string) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
export function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function transferRequest<T>(action: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The workspace transfer could not be completed. Please retry.');
  return result as T;
}
