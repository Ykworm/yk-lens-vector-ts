/**
 * Lance 原生存储（官方 @lancedb/lancedb）。
 * 文本表 text_chunks / 图像表 image_chunks，列语义对齐 yk-vector-go。
 */
import fs from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import {
  type ChunkRow,
  type SearchFilter,
  type SearchHit,
  ModalityImage,
  ModalityText,
  SpaceImage,
  SpaceText,
  effectiveModality,
} from "../types.js";
import { unixToLocalIso } from "../time.js";

const TABLE_TEXT = "text_chunks";
const TABLE_IMAGE = "image_chunks";

export class LanceStore {
  private db!: lancedb.Connection;
  private textTbl: lancedb.Table | null = null;
  private imageTbl: lancedb.Table | null = null;
  private textDim = 0;
  private imageDim = 0;
  private textIndexed = false;
  private imageIndexed = false;
  private openFlag = false;
  private mutex = Promise.resolve();

  constructor(
    private dir: string,
    private annMode: string,
  ) {
    this.annMode = normalizeAnn(annMode);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.mutex;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  static async open(dir: string, annMode: string): Promise<LanceStore> {
    const s = new LanceStore(dir, annMode);
    await s.init();
    return s;
  }

  private async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = await lancedb.connect(this.dir);
    const names = await this.db.tableNames();
    if (names.includes(TABLE_TEXT)) {
      this.textTbl = await this.db.openTable(TABLE_TEXT);
      this.textDim = await inferVectorDim(this.textTbl, "vector");
      this.textIndexed = await hasVectorIndex(this.textTbl, "vector");
      await ensureCollectionColumns(this.textTbl, TABLE_TEXT);
      await assertStringTimeColumns(this.textTbl, TABLE_TEXT);
    }
    if (names.includes(TABLE_IMAGE)) {
      this.imageTbl = await this.db.openTable(TABLE_IMAGE);
      this.imageDim = await inferVectorDim(this.imageTbl, "image_vector");
      this.imageIndexed = await hasVectorIndex(this.imageTbl, "image_vector");
      await ensureCollectionColumns(this.imageTbl, TABLE_IMAGE);
      await assertStringTimeColumns(this.imageTbl, TABLE_IMAGE);
    }
    this.openFlag = true;
    console.log(
      `lance open: path=${this.dir} ann=${this.annMode} text_dim=${this.textDim} image_dim=${this.imageDim}`,
    );
  }

  annEnabled(): boolean {
    return this.annMode !== "none";
  }

  async statusAsync(): Promise<{ open: boolean; chunks: number }> {
    if (!this.openFlag) return { open: false, chunks: 0 };
    let n = 0;
    if (this.textTbl) n += await this.textTbl.countRows();
    if (this.imageTbl) n += await this.imageTbl.countRows();
    return { open: true, chunks: n };
  }

  /** 只读 Admin：表清单（DEV / 实验台 Browse） */
  async listTables(): Promise<
    {
      name: string;
      rows: number;
      vector_column: string;
      vector_dim: number;
      vector_indexed: boolean;
    }[]
  > {
    const out: {
      name: string;
      rows: number;
      vector_column: string;
      vector_dim: number;
      vector_indexed: boolean;
    }[] = [];
    if (this.textTbl) {
      out.push({
        name: TABLE_TEXT,
        rows: await this.textTbl.countRows(),
        vector_column: "vector",
        vector_dim: this.textDim,
        vector_indexed: this.textIndexed,
      });
    }
    if (this.imageTbl) {
      out.push({
        name: TABLE_IMAGE,
        rows: await this.imageTbl.countRows(),
        vector_column: "image_vector",
        vector_dim: this.imageDim,
        vector_indexed: this.imageIndexed,
      });
    }
    return out;
  }

  /**
   * 只读 Admin：分页扫表。不返回向量列本体（太大），只带 vector_dim 元信息。
   * 可选 order_by（标量列）+ order=asc|desc；用 Lance Query.orderBy。
   * group_by=doc_id：按文档聚合，一行一篇；total=文档数，行内带 chunk_count。
   */
  async listRows(opts: {
    table: string;
    limit?: number;
    offset?: number;
    doc_id?: string;
    order_by?: string;
    order?: string;
    group_by?: string;
  }): Promise<{
    table: string;
    total: number;
    offset: number;
    limit: number;
    order_by: string;
    order: "asc" | "desc";
    group_by: string;
    scan_capped?: boolean;
    rows: Record<string, unknown>[];
  }> {
    return this.withLock(async () => {
      const name = (opts.table || TABLE_TEXT).trim();
      let tbl: lancedb.Table | null = null;
      let vectorCol = "vector";
      if (name === TABLE_TEXT) {
        tbl = this.textTbl;
        vectorCol = "vector";
      } else if (name === TABLE_IMAGE) {
        tbl = this.imageTbl;
        vectorCol = "image_vector";
      } else {
        throw new Error(`未知表 ${JSON.stringify(name)}（支持 text_chunks / image_chunks）`);
      }
      if (!tbl) {
        return {
          table: name,
          total: 0,
          offset: 0,
          limit: opts.limit ?? 20,
          order_by: "",
          order: "asc",
          group_by: "",
          rows: [],
        };
      }

      let limit = opts.limit ?? 20;
      if (limit <= 0) limit = 20;
      if (limit > 200) limit = 200;
      let offset = opts.offset ?? 0;
      if (offset < 0) offset = 0;

      const docId = (opts.doc_id || "").trim();
      const where = docId ? `doc_id = '${escapeSql(docId)}'` : "";

      const ascending = normalizeOrderAsc(opts.order);
      const groupBy = normalizeGroupBy(opts.group_by);
      const orderBy = await resolveOrderByColumn(tbl, opts.order_by, vectorCol);
      if (orderBy === "chunk_count" && groupBy !== "doc_id") {
        throw new Error("order_by=chunk_count 仅在 group_by=doc_id 时可用");
      }

      if (groupBy === "doc_id") {
        const agg = await listRowsGroupedByDocId(tbl, {
          where,
          orderBy,
          ascending,
          offset,
          limit,
          vectorCol,
        });
        return {
          table: name,
          total: agg.total,
          offset,
          limit,
          order_by: orderBy,
          order: ascending ? "asc" : "desc",
          group_by: "doc_id",
          scan_capped: agg.scan_capped,
          rows: agg.rows,
        };
      }

      const total = where ? await tbl.countRows(where) : await tbl.countRows();

      let q = tbl.query();
      if (where) q = q.where(where);
      if (orderBy) {
        q = q.orderBy({ columnName: orderBy, ascending });
      }
      // SDK 已支持 offset；有排序时必须用原生分页，避免「先 limit 再 slice」打乱序语义
      const raw = await q.offset(offset).limit(limit).toArray();

      const rows = raw.map((row) => stripVectorForBrowse(row as Record<string, unknown>, vectorCol));
      return {
        table: name,
        total,
        offset,
        limit,
        order_by: orderBy,
        order: ascending ? "asc" : "desc",
        group_by: "",
        rows,
      };
    });
  }

  async contentHash(docId: string): Promise<string> {
    return this.withLock(async () => {
      const filter = `doc_id = '${escapeSql(docId)}'`;
      for (const tbl of [this.textTbl, this.imageTbl]) {
        if (!tbl) continue;
        try {
          const rows = await tbl.query().where(filter).select(["content_hash"]).limit(1).toArray();
          if (rows[0]?.content_hash) return String(rows[0].content_hash);
        } catch {
          /* empty */
        }
      }
      return "";
    });
  }

  async deleteByDocId(docId: string): Promise<number> {
    return this.withLock(async () => {
      const filter = `doc_id = '${escapeSql(docId)}'`;
      let n = 0;
      for (const tbl of [this.textTbl, this.imageTbl]) {
        if (!tbl) continue;
        const before = await tbl.countRows();
        try {
          await tbl.delete(filter);
        } catch (e) {
          console.warn(`lance delete ${docId}:`, e);
        }
        const after = await tbl.countRows();
        if (before > after) n += before - after;
      }
      return n;
    });
  }

  /**
   * 按 chunk_id 删一行（upsert 用）。space=text|image。
   * 返回删除行数（0 或 1，表为空时 0）。
   */
  async deleteByChunkId(chunkId: string, space: string): Promise<number> {
    if (!chunkId) return 0;
    return this.withLock(async () => {
      const tbl = space === SpaceImage ? this.imageTbl : this.textTbl;
      if (!tbl) return 0;
      const filter = `chunk_id = '${escapeSql(chunkId)}'`;
      const before = await tbl.countRows(filter);
      if (before === 0) return 0;
      try {
        await tbl.delete(filter);
      } catch (e) {
        console.warn(`lance delete chunk_id ${chunkId}:`, e);
        return 0;
      }
      return before;
    });
  }

  async insertRows(rows: ChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    return this.withLock(async () => {
      const textRows = rows.filter((r) => effectiveModality(r) !== ModalityImage);
      const imageRows = rows.filter((r) => effectiveModality(r) === ModalityImage);

      if (textRows.length > 0) {
        const dim = textRows[0].vector?.length ?? 0;
        if (dim <= 0) throw new Error("text vector empty");
        const recs = textRows.map(toTextRecord);
        if (!this.textTbl) {
          this.textTbl = await this.db.createTable(TABLE_TEXT, recs);
          this.textDim = dim;
          await this.createScalarIndexes(this.textTbl);
        } else {
          if (this.textDim === 0) this.textDim = dim;
          else if (this.textDim !== dim) {
            throw new Error(`lance: text dim mismatch want=${this.textDim} got=${dim}`);
          }
          // 旧表可能缺 collection_*：先加列再 add，避免 "Found field not in schema"
          await ensureCollectionColumns(this.textTbl, TABLE_TEXT);
          await this.textTbl.add(recs);
        }
        await this.maybeIndex(this.textTbl, "vector", "text");
      }

      if (imageRows.length > 0) {
        const dim = imageRows[0].image_vector?.length ?? 0;
        if (dim <= 0) throw new Error("image vector empty");
        const recs = imageRows.map(toImageRecord);
        if (!this.imageTbl) {
          this.imageTbl = await this.db.createTable(TABLE_IMAGE, recs);
          this.imageDim = dim;
          await this.createScalarIndexes(this.imageTbl);
        } else {
          if (this.imageDim === 0) this.imageDim = dim;
          else if (this.imageDim !== dim) {
            throw new Error(`lance: image dim mismatch want=${this.imageDim} got=${dim}`);
          }
          await ensureCollectionColumns(this.imageTbl, TABLE_IMAGE);
          await this.imageTbl.add(recs);
        }
        await this.maybeIndex(this.imageTbl, "image_vector", "image");
      }
    });
  }

  private async createScalarIndexes(tbl: lancedb.Table): Promise<void> {
    for (const [col, cfg] of [
      ["doc_id", Index.btree()],
      ["project", Index.bitmap()],
      ["collection_id", Index.bitmap()],
      ["updated_at", Index.btree()],
    ] as const) {
      try {
        await tbl.createIndex(col, { config: cfg });
      } catch (e) {
        console.warn(`scalar index ${col}:`, e);
      }
    }
  }

  private async maybeIndex(tbl: lancedb.Table, col: string, which: "text" | "image"): Promise<void> {
    if (this.annMode === "none") return;
    if (which === "text" && this.textIndexed) return;
    if (which === "image" && this.imageIndexed) return;
    try {
      // 锁定：IVF_FLAT + cosine（docs/06）；文本列与图像列各自建索引
      await tbl.createIndex(col, {
        config: Index.ivfFlat({ distanceType: "cosine" }),
      });
      if (which === "text") this.textIndexed = true;
      else this.imageIndexed = true;
      console.log(`lance index ready: column=${col} type=ivf_flat distance=cosine`);
    } catch (e) {
      console.warn(`lance create_index ${col}:`, e);
    }
  }

  async searchExact(query: number[], limit: number, filter: SearchFilter): Promise<SearchHit[]> {
    if (!query.length) throw new Error("lance: empty query vector");
    if (limit <= 0) limit = 50;

    return this.withLock(async () => {
      const space = filter.space || SpaceText;
      const tbl = space === SpaceImage ? this.imageTbl : this.textTbl;
      const col = space === SpaceImage ? "image_vector" : "vector";
      if (!tbl) return [];

      const where = buildWhere(filter);
      let k = limit;
      if (where) k = Math.max(limit * 4, 50);

      let q = tbl.vectorSearch(query).column(col).distanceType("cosine").limit(k);
      if (where) q = q.where(where);
      if (this.annMode === "none") q = q.bypassVectorIndex();

      const rows = await q.toArray();
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const h = mapToHit(row as Record<string, unknown>, space);
        if (!matchFilter(h, filter)) continue;
        hits.push(h);
        if (hits.length >= limit) break;
      }
      hits.sort((a, b) => b.score - a.score);
      return hits;
    });
  }

  async updateMetaByDocId(docId: string, pathStr: string, title: string): Promise<number> {
    return this.withLock(async () => {
      const filter = `doc_id = '${escapeSql(docId)}'`;
      const valuesSql: Record<string, string> = {};
      if (pathStr) valuesSql.path = `'${escapeSql(pathStr)}'`;
      if (title) valuesSql.title = `'${escapeSql(title)}'`;
      if (Object.keys(valuesSql).length === 0) return 0;

      let n = 0;
      for (const tbl of [this.textTbl, this.imageTbl]) {
        if (!tbl) continue;
        const before = await tbl.countRows(filter);
        if (before === 0) continue;
        try {
          await tbl.update({ where: filter, valuesSql });
          n += before;
        } catch (e) {
          console.warn("lance update meta:", e);
        }
      }
      return n;
    });
  }

  /**
   * 对账：删除 doc_id 不在 validDocIds 里的所有 chunk。
   * 运维 prune / concept-clear 后清理孤儿用。不做磁盘回收（Lance 由后续 compact 负责）。
   */
  async pruneDocIds(validDocIds: string[]): Promise<{
    text_chunks: { pruned: number; docs_removed: number };
    image_chunks: { pruned: number; docs_removed: number };
  }> {
    const valid = new Set(validDocIds);
    const out = {
      text_chunks: { pruned: 0, docs_removed: 0 },
      image_chunks: { pruned: 0, docs_removed: 0 },
    };
    return this.withLock(async () => {
      const collectStale = async (tbl: lancedb.Table): Promise<string[]> => {
        const rows = await tbl.query().select(["doc_id"]).toArray();
        const seen = new Set<string>();
        const list: string[] = [];
        for (const r of rows) {
          const did = String((r as Record<string, unknown>).doc_id ?? "");
          if (!did || seen.has(did)) continue;
          seen.add(did);
          if (!valid.has(did)) list.push(did);
        }
        return list;
      };
      const deleteStale = async (
        tbl: lancedb.Table,
        stale: string[],
        key: "text_chunks" | "image_chunks",
      ): Promise<void> => {
        for (const did of stale) {
          const filter = `doc_id = '${escapeSql(did)}'`;
          const before = await tbl.countRows();
          try {
            await tbl.delete(filter);
          } catch (e) {
            console.warn(`lance prune delete doc_id=${did}:`, e);
            continue;
          }
          const after = await tbl.countRows();
          const removed = before - after;
          if (removed > 0) {
            out[key].pruned += removed;
            out[key].docs_removed += 1;
          }
        }
      };
      if (this.textTbl) {
        const stale = await collectStale(this.textTbl);
        await deleteStale(this.textTbl, stale, "text_chunks");
      }
      if (this.imageTbl) {
        const stale = await collectStale(this.imageTbl);
        await deleteStale(this.imageTbl, stale, "image_chunks");
      }
      return out;
    });
  }

  async close(): Promise<void> {
    this.openFlag = false;
    this.textTbl = null;
    this.imageTbl = null;
  }
}

function normalizeAnn(m: string): string {
  const x = (m || "").toLowerCase().trim();
  if (x === "none" || x === "exact" || x === "off") return "none";
  // 默认 / ivf_flat / 旧别名 ivf_hnsw_flat → 同一 IVF_FLAT 实现
  return "ivf_flat";
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

/** Admin 浏览排序：asc / desc（默认 asc） */
function normalizeOrderAsc(order?: string): boolean {
  const o = (order || "").trim().toLowerCase();
  if (o === "desc" || o === "descending" || o === "d") return false;
  return true;
}

/**
 * 解析 order_by 列名：空=不排序；须为表 schema 中的标量列（禁向量列）。
 */
async function resolveOrderByColumn(
  tbl: lancedb.Table,
  orderBy: string | undefined,
  vectorCol: string,
): Promise<string> {
  const col = (orderBy || "").trim();
  if (!col) return "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
    throw new Error(`非法 order_by 列名 ${JSON.stringify(col)}`);
  }
  if (col === vectorCol || col === "vector" || col === "image_vector") {
    throw new Error(`不能按向量列排序: ${col}`);
  }
  // 聚合虚拟列：内存排序，不必在 schema 里
  if (col === "chunk_count") return col;
  const schema = await tbl.schema();
  const names = new Set(schema.fields.map((f) => f.name));
  if (!names.has(col)) {
    throw new Error(`未知 order_by 列 ${JSON.stringify(col)}（表无此字段）`);
  }
  return col;
}

function normalizeGroupBy(groupBy?: string): "" | "doc_id" {
  const g = (groupBy || "").trim().toLowerCase();
  if (!g) return "";
  if (g === "doc_id" || g === "doc") return "doc_id";
  throw new Error(`未知 group_by ${JSON.stringify(groupBy)}（支持 doc_id）`);
}

/** 个人库规模：聚合扫描上限，避免一次拉爆内存 */
const GROUP_SCAN_CAP = 20000;

/**
 * 按 doc_id 聚合：扫标量列（不取向量），一行一篇文档 + chunk_count。
 * 代表行取 chunk_index 最小（无则先遇到的）；updated_at 取 max。
 */
async function listRowsGroupedByDocId(
  tbl: lancedb.Table,
  opts: {
    where: string;
    orderBy: string;
    ascending: boolean;
    offset: number;
    limit: number;
    vectorCol: string;
  },
): Promise<{ total: number; rows: Record<string, unknown>[]; scan_capped: boolean }> {
  const schema = await tbl.schema();
  const selectCols = schema.fields
    .map((f) => f.name)
    .filter((n) => n !== opts.vectorCol && n !== "vector" && n !== "image_vector");

  let q = tbl.query();
  if (opts.where) q = q.where(opts.where);
  if (selectCols.length) q = q.select(selectCols);
  // 有 chunk_index 时先按它排，方便取「首块」作代表
  if (selectCols.includes("chunk_index")) {
    q = q.orderBy({ columnName: "chunk_index", ascending: true });
  }

  const raw = await q.limit(GROUP_SCAN_CAP).toArray();
  const scan_capped = raw.length >= GROUP_SCAN_CAP;

  type Acc = {
    chunk_count: number;
    updated_at_max: string;
    rep: Record<string, unknown>;
    repIndex: number;
  };
  const byDoc = new Map<string, Acc>();

  for (const row of raw) {
    const r = row as Record<string, unknown>;
    const id = String(r.doc_id ?? "").trim();
    if (!id) continue;
    const idx = Number(r.chunk_index ?? Number.MAX_SAFE_INTEGER);
    // 定宽 RFC3339 字符串：字典序 = 时间序，直接字符串比较取 max
    const updated = String(r.updated_at ?? "");
    const cur = byDoc.get(id);
    if (!cur) {
      byDoc.set(id, {
        chunk_count: 1,
        updated_at_max: updated,
        rep: { ...r },
        repIndex: Number.isFinite(idx) ? idx : Number.MAX_SAFE_INTEGER,
      });
      continue;
    }
    cur.chunk_count += 1;
    if (updated > cur.updated_at_max) cur.updated_at_max = updated;
    if (Number.isFinite(idx) && idx < cur.repIndex) {
      cur.rep = { ...r };
      cur.repIndex = idx;
    }
  }

  let docs = [...byDoc.entries()].map(([doc_id, acc]) => {
    const out: Record<string, unknown> = {
      ...acc.rep,
      doc_id,
      chunk_count: acc.chunk_count,
      updated_at: acc.updated_at_max || acc.rep.updated_at || "",
    };
    // 聚合行：text 用首块预览；Detail 再拉全 chunk
    return out;
  });

  if (opts.orderBy) {
    const key = opts.orderBy;
    const asc = opts.ascending;
    docs.sort((a, b) => compareBrowseValues(a[key], b[key], asc));
  } else {
    // 默认按 updated_at desc
    docs.sort((a, b) => compareBrowseValues(a.updated_at, b.updated_at, false));
  }

  const total = docs.length;
  const slice = docs.slice(opts.offset, opts.offset + opts.limit);
  return { total, rows: slice, scan_capped };
}

function compareBrowseValues(a: unknown, b: unknown, ascending: boolean): number {
  const mul = ascending ? 1 : -1;
  if (a == null && b == null) return 0;
  if (a == null) return 1 * mul;
  if (b == null) return -1 * mul;
  if (typeof a === "number" && typeof b === "number") {
    if (a === b) return 0;
    return (a < b ? -1 : 1) * mul;
  }
  const sa = String(a);
  const sb = String(b);
  // 雪花 doc_id 等大整数：尽量按 BigInt 比
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    try {
      const da = BigInt(sa);
      const db = BigInt(sb);
      if (da === db) return 0;
      return (da < db ? -1 : 1) * mul;
    } catch {
      /* fallthrough */
    }
  }
  return sa.localeCompare(sb, "en") * mul;
}

/**
 * Step 19：旧 Lance 表无 collection_* 列时，add 会报
 * "Found field not in schema: collection_id"。
 * 启动 open 与每次 insert 前：缺列则 addColumns（旧行填默认空 / 0）。
 */
const COLLECTION_COLUMNS: { name: string; valueSql: string }[] = [
  { name: "collection_id", valueSql: "cast('' as string)" },
  { name: "collection_title", valueSql: "cast('' as string)" },
  { name: "collection_ord", valueSql: "cast(0 as int)" },
];

async function ensureCollectionColumns(tbl: lancedb.Table, label: string): Promise<void> {
  try {
    const schema = await tbl.schema();
    const have = new Set(schema.fields.map((f) => f.name));
    const missing = COLLECTION_COLUMNS.filter((c) => !have.has(c.name));
    if (missing.length === 0) return;
    await tbl.addColumns(missing);
    console.log(
      `lance schema migrate ${label}: +${missing.map((c) => c.name).join(",")}`,
    );
  } catch (e) {
    console.warn(`lance ensureCollectionColumns ${label}:`, e);
    throw e;
  }
}

/**
 * 2026-08-10 起 created_at / updated_at / indexed_at 改为 RFC3339 字符串（人类可读）。
 * 旧 int64 库无法原地改列类型，这里 fail-fast 给明确指引，而不是等 insert 报隐晦的类型错。
 */
async function assertStringTimeColumns(tbl: lancedb.Table, label: string): Promise<void> {
  const schema = await tbl.schema();
  for (const name of ["created_at", "updated_at", "indexed_at"]) {
    const f = schema.fields.find((x) => x.name === name);
    if (!f) continue;
    const t = String(f.type);
    if (!/utf8|string/i.test(t)) {
      throw new Error(
        `lance ${label}.${name} 列类型是 ${t}（旧 int64 格式）。` +
          `时间列已改为 RFC3339 字符串：请停服后清空 data/lance，重启并经 lensd ` +
          `POST /v1/admin/vector/reindex 重建（向量可再生）。`,
      );
    }
  }
}

function buildWhere(f: SearchFilter): string {
  const parts: string[] = [];
  if (f.project) parts.push(`project = '${escapeSql(f.project)}'`);
  if (f.collection_id) parts.push(`collection_id = '${escapeSql(f.collection_id)}'`);
  // 时间列是定宽 RFC3339 字符串：unix 秒入参转同款格式后按字典序比较
  if (f.updated_after != null) parts.push(`updated_at >= '${unixToLocalIso(f.updated_after)}'`);
  if (f.updated_before != null) parts.push(`updated_at <= '${unixToLocalIso(f.updated_before)}'`);
  return parts.join(" AND ");
}

function matchFilter(h: SearchHit, f: SearchFilter): boolean {
  if (f.project && h.project !== f.project) return false;
  if (f.collection_id && (h.collection_id || "") !== f.collection_id) return false;
  if (f.updated_after != null && h.updated_at < unixToLocalIso(f.updated_after)) return false;
  if (f.updated_before != null && h.updated_at > unixToLocalIso(f.updated_before)) return false;
  return true;
}

function toTextRecord(r: ChunkRow): Record<string, unknown> {
  return {
    chunk_id: r.chunk_id,
    doc_id: r.doc_id,
    path: r.path || "",
    content_hash: r.content_hash || "",
    project: r.project || "",
    title: r.title || "",
    text: r.text || "",
    vector: r.vector!,
    modality: ModalityText,
    chunk_index: r.chunk_index ?? 0,
    heading_path: r.heading_path || "",
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
    indexed_at: r.indexed_at ?? "",
    collection_id: r.collection_id || "",
    collection_title: r.collection_title || "",
    collection_ord: r.collection_ord ?? 0,
  };
}

function toImageRecord(r: ChunkRow): Record<string, unknown> {
  return {
    chunk_id: r.chunk_id,
    doc_id: r.doc_id,
    path: r.path || "",
    content_hash: r.content_hash || "",
    project: r.project || "",
    title: r.title || "",
    text: r.text || "",
    image_vector: r.image_vector!,
    modality: ModalityImage,
    image_index: r.image_index ?? 0,
    image_uri: r.image_uri || "",
    heading_path: r.heading_path || "",
    created_at: r.created_at ?? "",
    updated_at: r.updated_at ?? "",
    indexed_at: r.indexed_at ?? "",
    collection_id: r.collection_id || "",
    collection_title: r.collection_title || "",
    collection_ord: r.collection_ord ?? 0,
  };
}

function mapToHit(row: Record<string, unknown>, space: string): SearchHit {
  let score = 0;
  if (row._distance != null) {
    const dist = Number(row._distance);
    score = 1 - dist;
    if (score < 0) score = dist;
  } else if (row._score != null) {
    score = Number(row._score);
  }
  const text = String(row.text ?? "");
  const snippet = text.length > 240 ? text.slice(0, 240) + "…" : text;
  return {
    doc_id: String(row.doc_id ?? ""),
    path: String(row.path ?? ""),
    content_hash: String(row.content_hash ?? ""),
    chunk_id: String(row.chunk_id ?? ""),
    chunk_index: Number(row.chunk_index ?? 0),
    score,
    snippet,
    title: String(row.title ?? ""),
    project: String(row.project ?? ""),
    heading_path: row.heading_path != null ? String(row.heading_path) : undefined,
    modality: space === SpaceImage ? ModalityImage : ModalityText,
    image_index: row.image_index != null ? Number(row.image_index) : undefined,
    image_uri: row.image_uri != null ? String(row.image_uri) : undefined,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    indexed_at: String(row.indexed_at ?? ""),
    collection_id: row.collection_id != null ? String(row.collection_id) : undefined,
    collection_title: row.collection_title != null ? String(row.collection_title) : undefined,
    collection_ord: row.collection_ord != null ? Number(row.collection_ord) : undefined,
  };
}

/**
 * Lance / Arrow 读出的向量经常是 Float32Array / TypedArray，不是 Array.isArray。
 * 也兼容 { length }、带 toArray() 的对象。
 */
function vectorLength(v: unknown): number | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const len = (v as unknown as { length?: number }).length;
    return typeof len === "number" ? len : 0;
  }
  if (typeof v === "object") {
    const o = v as { length?: unknown; toArray?: () => unknown };
    if (typeof o.length === "number" && Number.isFinite(o.length) && o.length >= 0) {
      return o.length;
    }
    if (typeof o.toArray === "function") {
      try {
        return vectorLength(o.toArray());
      } catch {
        /* */
      }
    }
  }
  return null;
}

async function inferVectorDim(tbl: lancedb.Table, col: string): Promise<number> {
  try {
    const rows = await tbl.query().select([col]).limit(1).toArray();
    const n = vectorLength(rows[0]?.[col]);
    if (n != null && n > 0) return n;
  } catch {
    /* */
  }
  return 0;
}

async function hasVectorIndex(tbl: lancedb.Table, col: string): Promise<boolean> {
  try {
    const idxs = await tbl.listIndices();
    return idxs.some((i) => {
      const cols = (i as { columns?: string[] }).columns || [];
      return cols.includes(col);
    });
  } catch {
    return false;
  }
}

/** Browse 响应：向量只留维度，避免 JSON 爆炸。text 全文返回，由前端表格截断 / Detail 窗口展示。 */
function stripVectorForBrowse(row: Record<string, unknown>, vectorCol: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === vectorCol || k === "vector" || k === "image_vector") {
      const dim = vectorLength(v);
      out.vector_dim = dim;
      out.has_vector = dim != null && dim > 0;
      continue;
    }
    if (k === "image_uri" && typeof v === "string") {
      const uri = v;
      // http(s) MinIO/OSS：原样返回，前端可 <img src>
      if (uri.startsWith("http://") || uri.startsWith("https://")) {
        out.image_uri = uri;
        out.image_uri_preview = uri.length > 80 ? `${uri.slice(0, 80)}…` : uri;
        out.has_image_http = true;
        continue;
      }
      if (uri.startsWith("data:") && uri.length > 120) {
        const comma = uri.indexOf(",");
        const meta = comma > 0 ? uri.slice(0, Math.min(comma, 40)) : "data:";
        out.image_uri_preview = `${meta}… (${uri.length} chars)`;
        out.has_image_data_url = true;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}
