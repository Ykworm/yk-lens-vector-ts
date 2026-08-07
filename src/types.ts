/** 与 yk-vector-go 行模型 / HTTP 契约对齐 */

import { createHash } from "node:crypto";

export const ModalityText = "text";
export const ModalityImage = "image";
export const SpaceText = "text";
export const SpaceImage = "image";

export interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  path: string;
  content_hash: string;
  project: string;
  title: string;
  text: string;
  /** text_vector */
  vector?: number[];
  /** image_vector */
  image_vector?: number[];
  modality: string;
  chunk_index: number;
  image_index?: number;
  image_uri?: string;
  heading_path: string;
  created_at: number;
  updated_at: number;
  indexed_at: number;
  /** 合集（Step 19）；空 = 独立笔记 */
  collection_id?: string;
  collection_title?: string;
  collection_ord?: number;
}

export interface SearchHit {
  doc_id: string;
  path: string;
  content_hash: string;
  chunk_id: string;
  chunk_index: number;
  score: number;
  snippet: string;
  title: string;
  project: string;
  heading_path?: string;
  modality?: string;
  image_index?: number;
  image_uri?: string;
  created_at: number;
  updated_at: number;
  indexed_at: number;
  collection_id?: string;
  collection_title?: string;
  collection_ord?: number;
}

export interface SearchFilter {
  project?: string;
  updated_after?: number | null;
  updated_before?: number | null;
  collection_id?: string;
  space?: string;
}

export function makeChunkId(docId: string, index: number): string {
  return `${docId}#${index}`;
}

/** @deprecated 序号语义已弃用；请用 makeImageChunkIdFromKey */
export function makeImageChunkId(docId: string, imageIndex: number): string {
  return `${docId}#img#${imageIndex}`;
}

/**
 * 图行主键：doc_id + 内容键的短 hash（uri / 字节指纹）。
 * 不做「第几张」业务语义（见 docs/07）。
 */
export function makeImageChunkIdFromKey(docId: string, key: string): string {
  const h = createHash("sha256").update(key || "empty").digest("hex").slice(0, 16);
  return `${docId}#img#${h}`;
}

/** data URL 过长时不落库全文，只留 mime + 内容 hash + 长度 */
export function compactImageUri(uri: string): string {
  if (!uri) return "";
  if (!uri.startsWith("data:") || uri.length <= 160) return uri;
  const comma = uri.indexOf(",");
  const meta = comma > 0 ? uri.slice(0, Math.min(comma, 48)) : "data:";
  const payload = comma > 0 ? uri.slice(comma + 1) : uri;
  const h = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `${meta},#sha256=${h} (${uri.length} chars)`;
}

export function effectiveModality(row: ChunkRow): string {
  return row.modality || ModalityText;
}
