import {
  buildEmbedInput,
  buildEmbedInputCoreOnly,
  type EnrichOptions,
} from "../chunk/embedText.js";
import { splitHeadingRecursive } from "../chunk/headingRecursive.js";
import { EmbedClient, ErrNotConfigured } from "../embed/client.js";
import { VLClient } from "../embed/vl.js";
import { extractImages, fetchImage } from "../image/extract.js";
import { aggregateByDocId } from "../store/aggregate.js";
import type { LanceStore } from "../store/lanceStore.js";
import {
  type ChunkRow,
  type SearchHit,
  ModalityImage,
  ModalityText,
  SpaceImage,
  SpaceText,
  compactImageUri,
  makeChunkId,
  makeImageChunkIdFromKey,
  sha256Hex,
} from "../types.js";
import type { ObjectStore } from "../store/objectStore.js";
import { JobQueue } from "./jobs.js";
import { nowLocalIso, unixToLocalIso } from "../time.js";

export interface ReplaceRequest {
  doc_id: string;
  path: string;
  content_hash: string;
  project: string;
  title: string;
  content: string;
  /** 对外契约：unix 秒；入库边界转 RFC3339 字符串（src/time.ts） */
  created_at: number;
  updated_at: number;
  collection_id?: string;
  collection_title?: string;
  collection_ord?: number;
  /** true = 忽略 content_hash skip，先删后建整篇重建 */
  remove_and_insert?: boolean;
  async?: boolean;
}

export interface ReplaceResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  doc_id: string;
  chunks: number;
  /** 文本块数 */
  text_chunks?: number;
  /** 成功写入的图像行数 */
  image_chunks?: number;
  /** 幂等对齐跳过的图像数（file_hash 已入库，未调 VL embed） */
  image_skipped?: number;
  /** 抽到的附图数（含失败） */
  images_found?: number;
  /** 附图 embed/入库失败摘要（不拖垮整篇） */
  image_errors?: string[];
  job_id?: string;
  status?: string;
}

export interface RenameRequest {
  doc_id: string;
  path?: string;
  title?: string;
}

/** 显式文本入库（简单测试；失败直接抛错） */
export interface UpsertTextRequest {
  doc_id: string;
  text: string;
  path?: string;
  project?: string;
  title?: string;
  content_hash?: string;
  chunk_index?: number;
  heading_path?: string;
  created_at?: number;
  updated_at?: number;
}

/** 显式图像入库（简单测试；失败直接抛错，不软忽略） */
export interface UpsertImageRequest {
  doc_id: string;
  path?: string;
  project?: string;
  title?: string;
  content_hash?: string;
  alt?: string;
  heading_path?: string;
  image_base64?: string;
  image_mime?: string;
  image_data_url?: string;
  /** 可选稳定键；默认用 data URL / base64 指纹 */
  image_key?: string;
  /** image 文件本体 sha256 hex（T4 幂等对齐；缺省按字节算） */
  file_hash?: string;
  created_at?: number;
  updated_at?: number;
}

export interface UpsertResult {
  ok: boolean;
  doc_id: string;
  chunk_id: string;
  modality: string;
  replaced: boolean;
  status: string;
  /** 图：可预览 URL（MinIO/OSS）或压碎后的 data 指纹 */
  image_uri?: string;
}

export interface UploadAssetRequest {
  doc_id?: string;
  image_base64?: string;
  image_mime?: string;
  image_data_url?: string;
}

export interface SearchRequest {
  query?: string;
  limit?: number;
  project?: string;
  updated_after?: number | null;
  updated_before?: number | null;
  collection_id?: string;
  aggregate?: boolean | null;
  mode?: string;
  image_base64?: string;
  image_mime?: string;
  image_data_url?: string;
}

export const ModeText = "text";
export const ModeTextToImage = "text_to_image";
export const ModeImageToImage = "image_to_image";

export class IndexService {
  jobs: JobQueue | null = null;
  asyncDefault = false;
  maxImagesPerDoc = 32;
  objectStore: ObjectStore | null = null;

  constructor(
    public store: LanceStore,
    public embed: EmbedClient,
    public vl: VLClient,
    private chunkOpts: {
      maxTokens: number;
      overlapTokens: number;
      enrich?: boolean;
      enrichNeighborChars?: number;
      enrichMeta?: boolean;
      enrichMaxChars?: number;
    },
  ) {}

  private enrichOpts(): EnrichOptions {
    return {
      enabled: this.chunkOpts.enrich !== false,
      neighborChars: this.chunkOpts.enrichNeighborChars ?? 256,
      meta: this.chunkOpts.enrichMeta !== false,
      maxChars: this.chunkOpts.enrichMaxChars ?? 4000,
    };
  }

  async healthz(): Promise<{
    ok: boolean;
    lance: string;
    embedding: boolean;
    vl: boolean;
    chunks: number;
    ann?: string;
    object_store?: boolean;
  }> {
    const st = await this.store.statusAsync();
    return {
      ok: st.open,
      lance: st.open ? "open" : "closed",
      embedding: this.embed.configured(),
      vl: this.vl.configured(),
      chunks: st.chunks,
      ann: this.store.annEnabled() ? "ivf_flat" : "none",
      object_store: this.objectStore?.isReady() === true,
    };
  }

  /** 只读 Lance 表清单（Admin / 实验台 Browse） */
  async listTables() {
    return this.store.listTables();
  }

  /** 只读分页扫表（可选 order_by / order / group_by=doc_id） */
  async listRows(opts: {
    table: string;
    limit?: number;
    offset?: number;
    doc_id?: string;
    order_by?: string;
    order?: string;
    group_by?: string;
  }) {
    return this.store.listRows(opts);
  }

  async replace(req: ReplaceRequest): Promise<ReplaceResult> {
    if (!req.doc_id) throw new Error("doc_id 必填");
    if (!req.content) throw new Error("content 必填");

    // remove_and_insert=true：不看 content_hash，整篇先删后建
    if (!req.remove_and_insert && req.content_hash) {
      const existing = await this.store.contentHash(req.doc_id);
      if (existing && existing === req.content_hash) {
        return {
          ok: true,
          skipped: true,
          reason: "content_hash unchanged",
          doc_id: req.doc_id,
          chunks: 0,
          status: "done",
        };
      }
    }

    const wantAsync = Boolean(req.async || this.asyncDefault);
    if (wantAsync && this.jobs) {
      const jobId = this.jobs.enqueueReplace(req);
      return { ok: true, doc_id: req.doc_id, chunks: 0, job_id: jobId, status: "queued" };
    }
    return this.replaceSync(req);
  }

  /** 同步 replace（jobs worker 也调用） */
  async replaceSync(req: ReplaceRequest): Promise<ReplaceResult> {
    if (!this.embed.configured()) throw ErrNotConfigured;

    // T4 image 幂等对齐：
    // - remove_and_insert（运维 vector/reindex）→ 维持整篇先删后建（修复用，强制全量）；
    // - 常规 replace → 只删 text，image 按 file_hash 对账，已入库的跳过 VL embed（不重复调 API）。
    const forceRebuild = Boolean(req.remove_and_insert);
    if (forceRebuild) {
      await this.store.deleteByDocId(req.doc_id);
    } else {
      await this.store.deleteTextByDocId(req.doc_id);
    }

    const { body, pieces } = splitHeadingRecursive(req.content, {
      maxTokens: this.chunkOpts.maxTokens,
      overlapTokens: this.chunkOpts.overlapTokens,
    });
    const now = nowLocalIso();
    const rows: ChunkRow[] = [];
    const eopts = this.enrichOpts();

    for (const p of pieces) {
      // 库内 text = 切片 core；vector = embed(邻域窗口 + 可选 meta)
      const embedInput = buildEmbedInput(
        body,
        p.text,
        p.start,
        p.end,
        {
          title: req.title,
          path: req.path,
          heading_path: p.headingPath,
        },
        eopts,
      );
      const vec = await this.embed.embed(embedInput);
      if (!vec.length) throw new Error(`embed chunk ${p.chunkIndex}: empty`);
      rows.push({
        chunk_id: makeChunkId(req.doc_id, p.chunkIndex),
        doc_id: req.doc_id,
        path: req.path || "",
        content_hash: req.content_hash || "",
        project: req.project || "",
        title: req.title || "",
        text: p.text,
        vector: vec,
        modality: ModalityText,
        chunk_index: p.chunkIndex,
        heading_path: p.headingPath,
        created_at: unixToLocalIso(req.created_at),
        updated_at: unixToLocalIso(req.updated_at),
        indexed_at: now,
        collection_id: req.collection_id || "",
        collection_title: req.collection_title || "",
        collection_ord: req.collection_ord || 0,
      });
    }

    let imagesFound = 0;
    let imageChunks = 0;
    let imageSkipped = 0;
    const imageErrors: string[] = [];
    const textChunks = rows.length;

    if (this.vl.configured()) {
      const maxImg = this.maxImagesPerDoc > 0 ? this.maxImagesPerDoc : 32;
      const refs = extractImages(req.content, maxImg);
      imagesFound = refs.length;
      // 一次查询该 doc 已入库 image 的 file_hash 集合（不逐 chunk 判断，T4）
      let existingHashes: Set<string> | null = null;
      if (!forceRebuild && refs.length > 0) {
        existingHashes = await this.store.imageFileHashes(req.doc_id);
      }
      const refHashes = new Set<string>(); // 本次 md 引用的全部 file_hash（清理依据）
      for (const ref of refs) {
        const shortUri = ref.uri.length > 64 ? `${ref.uri.slice(0, 64)}…` : ref.uri;
        try {
          if (isRelativeImageUri(ref.uri)) {
            imageErrors.push(`${shortUri}: relative_path_needs_upstream（本服务不持 vault）`);
            continue;
          }
          const fetched = await fetchImage(ref);
          const fileHash = fetched.bytes?.length
            ? sha256Hex(fetched.bytes)
            : sha256Hex(fetched.uri);
          refHashes.add(fileHash);
          // 已入库（T4 导入或上次管线）且本次非强制重建 → 跳过 VL embed，保留旧行
          if (existingHashes && existingHashes.has(fileHash)) {
            imageSkipped++;
            continue;
          }
          let iv: number[];
          if (fetched.bytes?.length) {
            iv = await this.vl.embedImage(fetched.bytes, fetched.mime || "image/png");
          } else {
            iv = await this.vl.embedImageDataURL(fetched.uri);
          }
          if (!iv.length) {
            imageErrors.push(`${shortUri}: empty embedding`);
            continue;
          }
          const chunkId = makeImageChunkIdFromKey(req.doc_id, ref.uri);
          const imageUri = await this.resolveImageUri(req.doc_id, ref.uri, fetched.bytes, fetched.mime);
          rows.push({
            chunk_id: chunkId,
            doc_id: req.doc_id,
            path: req.path || "",
            content_hash: req.content_hash || "",
            project: req.project || "",
            title: req.title || "",
            text: ref.alt || "",
            image_vector: iv,
            modality: ModalityImage,
            chunk_index: 0,
            image_uri: imageUri,
            heading_path: "",
            created_at: unixToLocalIso(req.created_at),
            updated_at: unixToLocalIso(req.updated_at),
            collection_id: req.collection_id || "",
            collection_title: req.collection_title || "",
            collection_ord: req.collection_ord || 0,
            indexed_at: now,
            file_hash: fileHash,
          });
          imageChunks++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          imageErrors.push(`${shortUri}: ${msg}`);
          console.warn(`skip image ${shortUri} (doc ${req.doc_id}):`, e);
        }
      }
      // 清理：md 不再引用的图 + 旧空 file_hash 行（forceRebuild 已全删，无需再清）
      if (!forceRebuild) {
        const pruned = await this.store.deleteImagesNotIn(req.doc_id, refHashes);
        if (pruned > 0) {
          console.log(`replace doc=${req.doc_id}: 清理未引用 image ${pruned} 行`);
        }
      }
    } else if (extractImages(req.content, 1).length > 0) {
      imageErrors.push("vl_not_configured：MD 含图但 VL 未配置，附图已跳过");
    }

    if (rows.length === 0) {
      return {
        ok: true,
        doc_id: req.doc_id,
        chunks: 0,
        text_chunks: 0,
        image_chunks: 0,
        image_skipped: imageSkipped,
        images_found: imagesFound,
        image_errors: imageErrors.length ? imageErrors : undefined,
        status: "done",
      };
    }
    await this.store.insertRows(rows);
    return {
      ok: true,
      doc_id: req.doc_id,
      chunks: rows.length,
      text_chunks: textChunks,
      image_chunks: imageChunks,
      image_skipped: imageSkipped,
      images_found: imagesFound,
      image_errors: imageErrors.length ? imageErrors : undefined,
      status: "done",
    };
  }

  async rename(req: RenameRequest): Promise<{ ok: boolean; doc_id: string; updated: number }> {
    if (!req.doc_id) throw new Error("doc_id 必填");
    if (!req.path && !req.title) throw new Error("path 或 title 至少填一个");
    const n = await this.store.updateMetaByDocId(req.doc_id, req.path || "", req.title || "");
    return { ok: true, doc_id: req.doc_id, updated: n };
  }

  async delete(docId: string): Promise<{ ok: boolean; doc_id: string; deleted: number }> {
    if (!docId) throw new Error("doc_id 必填");
    const n = await this.store.deleteByDocId(docId);
    return { ok: true, doc_id: docId, deleted: n };
  }

  /**
   * 对账：删除 doc_id 不在 valid_doc_ids 白名单里的所有 chunk。
   * 运维 prune / concept-clear 后清理孤儿用。
   */
  async prune(req: { valid_doc_ids: string[] }): Promise<{
    ok: boolean;
    pruned: number;
    docs_removed: number;
    tables: {
      text_chunks: { pruned: number; docs_removed: number };
      image_chunks: { pruned: number; docs_removed: number };
    };
  }> {
    const valid = Array.isArray(req.valid_doc_ids) ? req.valid_doc_ids.filter(Boolean) : [];
    const tables = await this.store.pruneDocIds(valid);
    const pruned = tables.text_chunks.pruned + tables.image_chunks.pruned;
    const docs_removed = tables.text_chunks.docs_removed + tables.image_chunks.docs_removed;
    console.log(
      `vector prune: valid=${valid.length} pruned_chunks=${pruned} docs_removed=${docs_removed}`,
    );
    return { ok: true, pruned, docs_removed, tables };
  }

  /**
   * 显式文本入库：单块 text → text_chunks。
   * 同 chunk_id 先删后插；失败直接抛错（不像 MD 附图软忽略）。
   */
  async upsertText(req: UpsertTextRequest): Promise<UpsertResult> {
    if (!req.doc_id) throw new Error("doc_id 必填");
    const text = (req.text || "").trim();
    if (!text) throw new Error("text 必填");
    if (!this.embed.configured()) throw ErrNotConfigured;

    const chunkIndex = req.chunk_index != null && req.chunk_index >= 0 ? req.chunk_index : 0;
    const chunkId = makeChunkId(req.doc_id, chunkIndex);
    // upsert 无全文：meta + core，无邻域
    const embedInput = buildEmbedInputCoreOnly(
      text,
      {
        title: req.title,
        path: req.path,
        heading_path: req.heading_path,
      },
      this.enrichOpts(),
    );
    const vec = await this.embed.embed(embedInput);
    if (!vec.length) throw new Error("embedding 结果为空");

    const deleted = await this.store.deleteByChunkId(chunkId, SpaceText);
    const now = nowLocalIso();
    await this.store.insertRows([
      {
        chunk_id: chunkId,
        doc_id: req.doc_id,
        path: req.path || "",
        content_hash: req.content_hash || "",
        project: req.project || "",
        title: req.title || "",
        text,
        vector: vec,
        modality: ModalityText,
        chunk_index: chunkIndex,
        heading_path: req.heading_path || "",
        created_at: unixToLocalIso(req.created_at),
        updated_at: unixToLocalIso(req.updated_at),
        indexed_at: now,
      },
    ]);
    return {
      ok: true,
      doc_id: req.doc_id,
      chunk_id: chunkId,
      modality: ModalityText,
      replaced: deleted > 0,
      status: "done",
    };
  }

  /**
   * 显式图像入库：一张图 → image_chunks。
   * 失败直接抛错（测试通路干净）；成功才写库。
   */
  async upsertImage(req: UpsertImageRequest): Promise<UpsertResult> {
    if (!req.doc_id) throw new Error("doc_id 必填");
    if (!this.vl.configured()) {
      throw new Error("vl embedding 未配置（upsert_image 需要 qwen3-vl-embedding）");
    }

    let dataURL = "";
    if (req.image_data_url?.trim()) {
      dataURL = req.image_data_url.trim();
    } else if (req.image_base64?.trim()) {
      const raw = req.image_base64.trim();
      if (raw.startsWith("data:")) dataURL = raw;
      else {
        const mime = req.image_mime || "image/png";
        dataURL = `data:${mime};base64,${raw}`;
      }
    } else {
      throw new Error("image_base64 或 image_data_url 必填");
    }

    const key = (req.image_key || dataURL).trim();
    const chunkId = makeImageChunkIdFromKey(req.doc_id, key);
    const iv = await this.vl.embedImageDataURL(dataURL);
    if (!iv.length) throw new Error("vl embedding 结果为空");
    // T4 幂等对齐：file_hash = image 文件本体 sha256（缺省按字节算，与 lensd 传入一致）
    const fileHash = req.file_hash || sha256Hex(dataURLBytes(dataURL));

    const imageUri = await this.resolveImageUri(req.doc_id, dataURL);
    const deleted = await this.store.deleteByChunkId(chunkId, SpaceImage);
    const now = nowLocalIso();
    await this.store.insertRows([
      {
        chunk_id: chunkId,
        doc_id: req.doc_id,
        path: req.path || "",
        content_hash: req.content_hash || "",
        project: req.project || "",
        title: req.title || "",
        text: req.alt || "",
        image_vector: iv,
        modality: ModalityImage,
        chunk_index: 0,
        image_uri: imageUri,
        heading_path: req.heading_path || "",
        created_at: unixToLocalIso(req.created_at),
        updated_at: unixToLocalIso(req.updated_at),
        indexed_at: now,
        file_hash: fileHash,
      },
    ]);
    return {
      ok: true,
      doc_id: req.doc_id,
      chunk_id: chunkId,
      modality: ModalityImage,
      replaced: deleted > 0,
      status: "done",
      image_uri: imageUri,
    };
  }

  /** 只上传到对象存储，返回可预览 URL（不写 Lance） */
  async uploadAsset(req: UploadAssetRequest): Promise<{
    ok: boolean;
    url: string;
    key: string;
    bucket: string;
  }> {
    if (!this.objectStore?.isReady()) {
      throw new Error("object_store 未启用或未就绪（配置 object_store + 启动 MinIO）");
    }
    let dataURL = "";
    if (req.image_data_url?.trim()) dataURL = req.image_data_url.trim();
    else if (req.image_base64?.trim()) {
      const raw = req.image_base64.trim();
      if (raw.startsWith("data:")) dataURL = raw;
      else dataURL = `data:${req.image_mime || "image/png"};base64,${raw}`;
    } else {
      throw new Error("image_base64 或 image_data_url 必填");
    }
    const up = await this.objectStore.putImageDataURL(req.doc_id || "upload", dataURL);
    return { ok: true, url: up.url, key: up.key, bucket: up.bucket };
  }

  /**
   * data URL / http → 写入 image_uri：
   * - object_store 就绪且为 data URL → 上传 MinIO/OSS，返回 public URL
   * - 已是 http(s) → 原样
   * - 否则 compact data URL
   */
  private async resolveImageUri(
    docId: string,
    uri: string,
    bytes?: Buffer,
    mime?: string,
  ): Promise<string> {
    const u = (uri || "").trim();
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    if (this.objectStore?.isReady() && (u.startsWith("data:") || bytes?.length)) {
      try {
        if (bytes?.length) {
          const up = await this.objectStore.putImage({
            docId,
            bytes,
            mime: mime || "image/png",
          });
          return up.url;
        }
        if (u.startsWith("data:")) {
          const up = await this.objectStore.putImageDataURL(docId, u);
          return up.url;
        }
      } catch (e) {
        console.warn("object_store upload failed, fallback compact uri:", e);
      }
    }
    if (u.startsWith("data:")) return compactImageUri(u);
    return u;
  }

  async search(req: SearchRequest): Promise<{
    hits: SearchHit[];
    total: number;
    aggregated: boolean;
    mode: string;
  }> {
    const mode = normalizeSearchMode(req.mode);
    let limit = req.limit ?? 50;
    if (limit <= 0) limit = 50;
    if (limit > 200) limit = 200;
    const doAgg = req.aggregate === false ? false : true;

    const { vec, space } = await this.encodeQuery(mode, req);

    let fetch = limit;
    if (doAgg) {
      fetch = Math.min(200, Math.max(50, limit * 4));
    }

    let hits = await this.store.searchExact(vec, fetch, {
      project: req.project,
      updated_after: req.updated_after,
      updated_before: req.updated_before,
      collection_id: req.collection_id,
      space,
    });
    if (doAgg) hits = aggregateByDocId(hits, limit);
    else if (hits.length > limit) hits = hits.slice(0, limit);

    return { hits, total: hits.length, aggregated: doAgg, mode };
  }

  private async encodeQuery(
    mode: string,
    req: SearchRequest,
  ): Promise<{ vec: number[]; space: string }> {
    switch (mode) {
      case ModeText: {
        const q = (req.query || "").trim();
        if (!q) throw new Error("query 必填");
        if (!this.embed.configured()) throw ErrNotConfigured;
        const vec = await this.embed.embed(q);
        return { vec, space: SpaceText };
      }
      case ModeTextToImage: {
        const q = (req.query || "").trim();
        if (!q) throw new Error("query 必填");
        if (!this.vl.configured()) {
          throw new Error("vl embedding 未配置（文搜图需要 qwen3-vl-embedding）");
        }
        const vec = await this.vl.embedText(q);
        return { vec, space: SpaceImage };
      }
      case ModeImageToImage: {
        if (!this.vl.configured()) {
          throw new Error("vl embedding 未配置（图搜图需要 qwen3-vl-embedding）");
        }
        let vec: number[];
        if (req.image_data_url) {
          vec = await this.vl.embedImageDataURL(req.image_data_url);
        } else if (req.image_base64) {
          const raw = req.image_base64;
          if (raw.startsWith("data:")) {
            vec = await this.vl.embedImageDataURL(raw);
          } else {
            const mime = req.image_mime || "image/png";
            vec = await this.vl.embedImageDataURL(`data:${mime};base64,${raw}`);
          }
        } else {
          throw new Error("image_base64 或 image_data_url 必填");
        }
        return { vec, space: SpaceImage };
      }
      default:
        throw new Error(`未知 mode ${JSON.stringify(mode)}（支持 text / text_to_image / image_to_image）`);
    }
  }
}

function normalizeSearchMode(m?: string): string {
  switch (m) {
    case undefined:
    case "":
    case "text":
    case "text_to_text":
      return ModeText;
    case "text_to_image":
    case "text-to-image":
    case "文搜图":
      return ModeTextToImage;
    case "image_to_image":
    case "image-to-image":
    case "图搜图":
      return ModeImageToImage;
    default:
      return m;
  }
}

function isRelativeImageUri(uri: string): boolean {
  const u = (uri || "").trim();
  if (!u) return true;
  if (u.startsWith("data:")) return false;
  if (u.startsWith("http://") || u.startsWith("https://")) return false;
  return true;
}

/** data URL → 原始字节（file_hash 缺省计算用） */
function dataURLBytes(dataURL: string): Buffer {
  const comma = dataURL.indexOf(",");
  return Buffer.from(dataURL.slice(comma + 1), "base64");
}
