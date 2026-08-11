/**
 * T4 image 幂等对齐：replaceSync 对已入库（file_hash 相同）的 image 跳过 VL embed。
 * 用真实 LanceStore（临时目录）+ 假 embed/vl（不调外部 API）。
 * 运行：npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LanceStore } from "../store/lanceStore.js";
import { EmbedClient } from "../embed/client.js";
import { VLClient } from "../embed/vl.js";
import { IndexService, type ReplaceRequest } from "./indexService.js";
import { sha256Hex, SpaceImage } from "../types.js";

const PNG = Buffer.from("fake-png-image-bytes");
const FILE_HASH = sha256Hex(PNG);

function dim(v: number, n: number): number[] {
  const a = new Array(n).fill(0);
  a[v % n] = 1;
  return a;
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ykvec-img-"));
  const store = await LanceStore.open(dir, "none");

  const embed = new EmbedClient("http://x", "k", "m", 5000);
  (embed as unknown as { embed: () => Promise<number[]> }).embed = async () => dim(0, 8);
  (embed as unknown as { embedBatch: () => Promise<number[][]> }).embedBatch = async () => [dim(0, 8)];

  let vlCalls = 0;
  const vl = new VLClient("http://x", "k", "m", 5000);
  (vl as unknown as { embedImage: () => Promise<number[]> }).embedImage = async () => {
    vlCalls++;
    return dim(1, 8);
  };
  (vl as unknown as { embedImageDataURL: () => Promise<number[]> }).embedImageDataURL = async () => {
    vlCalls++;
    return dim(1, 8);
  };

  const svc = new IndexService(store, embed, vl, {
    maxTokens: 512,
    overlapTokens: 64,
    enrich: false,
  });

  // 本地 HTTP 服务图片字节（fetchImage 下载路径）
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(PNG);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/img.png`;

  const req = (contentHash: string, content: string, removeAndInsert = false): ReplaceRequest => ({
    doc_id: "doc1",
    path: "inbox/imports/img.md",
    content_hash: contentHash,
    project: "inbox",
    title: "img",
    content,
    created_at: 1786363201,
    updated_at: 1786363202,
    remove_and_insert: removeAndInsert,
  });

  return {
    store,
    svc,
    vlCalls: () => vlCalls,
    url,
    req,
    cleanup: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const withImg = (url: string) => `# 图\n\n![原图](${url})\n\n## Vision 描述\n\n一张图`;

test("replaceSync：首次 embed 一次，二次同图跳过（file_hash 幂等）", async (t) => {
  const env = await setup();
  t.after(env.cleanup);

  const r1 = await env.svc.replaceSync(env.req("h1", withImg(env.url)));
  assert.equal(r1.image_chunks, 1, "首次应写入 1 张 image");
  assert.equal(r1.image_skipped, 0);
  assert.equal(env.vlCalls(), 1, "首次应调 1 次 VL embed");

  // 正文变化（content_hash 变）但同一张图 → image 跳过，text 重建
  const r2 = await env.svc.replaceSync(env.req("h2", withImg(env.url)));
  assert.equal(r2.image_chunks, 0, "二次不应新写 image");
  assert.equal(r2.image_skipped, 1, "二次应跳过 1 张已入库图");
  assert.equal(env.vlCalls(), 1, "二次不应再调 VL embed");

  // 图行仍在，且带 file_hash
  const rows = await env.store.listRows({ table: "image_chunks", doc_id: "doc1" });
  assert.equal(rows.total, 1, "image 行应保留");
  const row = rows.rows[0];
  assert.equal(String(row.file_hash), FILE_HASH, "file_hash 应等于图片字节 sha256");
});

test("replaceSync：md 移除图 → 清理旧 image 行", async (t) => {
  const env = await setup();
  t.after(env.cleanup);

  await env.svc.replaceSync(env.req("h1", withImg(env.url)));
  assert.equal(env.vlCalls(), 1);

  const r3 = await env.svc.replaceSync(env.req("h3", "# 纯文字，无图"));
  assert.equal(r3.images_found, 0);
  const rows = await env.store.listRows({ table: "image_chunks", doc_id: "doc1" });
  assert.equal(rows.total, 0, "未引用图应被清理");
  assert.equal(env.vlCalls(), 1, "清理不应调 VL embed");
});

test("replaceSync：remove_and_insert 强制全量，不跳过", async (t) => {
  const env = await setup();
  t.after(env.cleanup);

  await env.svc.replaceSync(env.req("h1", withImg(env.url)));
  assert.equal(env.vlCalls(), 1);

  const r4 = await env.svc.replaceSync(env.req("h2", withImg(env.url), true));
  assert.equal(r4.image_skipped, 0, "强制重建不应跳过");
  assert.equal(r4.image_chunks, 1);
  assert.equal(env.vlCalls(), 2, "强制重建应重新 embed");
});

test("replaceSync：upsert_image 先行 → 管线 replace 跳过（T4 跨路径幂等）", async (t) => {
  const env = await setup();
  t.after(env.cleanup);

  // lensd T4 导入路径：upsert_image 带 file_hash 先入库
  await env.svc.upsertImage({
    doc_id: "doc1",
    image_data_url: `data:image/png;base64,${PNG.toString("base64")}`,
    file_hash: FILE_HASH,
    image_key: env.url, // 与 md 引用一致 → chunk_id 一致
  });
  assert.equal(env.vlCalls(), 1);

  // 管线 index_vector replace（content_hash 不同）→ 同图跳过
  const r = await env.svc.replaceSync(env.req("h-pipeline", withImg(env.url)));
  assert.equal(r.image_skipped, 1, "管线 replace 应跳过 T4 已入库的图");
  assert.equal(env.vlCalls(), 1, "不应重复调 VL embed");

  const rows = await env.store.listRows({ table: "image_chunks", doc_id: "doc1" });
  assert.equal(rows.total, 1, "image 行应只有 1 条（无重复）");
  assert.equal(String(rows.rows[0].file_hash), FILE_HASH);
});

test("upsertImage：file_hash 缺省按字节计算", async (t) => {
  const env = await setup();
  t.after(env.cleanup);

  await env.svc.upsertImage({
    doc_id: "doc2",
    image_data_url: `data:image/png;base64,${PNG.toString("base64")}`,
  });
  const rows = await env.store.listRows({ table: "image_chunks", doc_id: "doc2" });
  assert.equal(rows.total, 1);
  assert.equal(String(rows.rows[0].file_hash), FILE_HASH, "缺省 file_hash 应为字节 sha256");
  // 表列齐全（file_hash 可查）
  await env.store.deleteByChunkId(String(rows.rows[0].chunk_id), SpaceImage);
  const after = await env.store.listRows({ table: "image_chunks", doc_id: "doc2" });
  assert.equal(after.total, 0);
});
