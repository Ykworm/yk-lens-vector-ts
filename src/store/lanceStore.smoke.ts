/**
 * 本地 smoke：不依赖真实 embedding API。
 * 运行：npx tsx src/store/lanceStore.smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import { LanceStore } from "./lanceStore.js";
import { aggregateByDocId } from "./aggregate.js";
import type { ChunkRow } from "../types.js";
import { ModalityText, makeChunkId } from "../types.js";
import { unixToLocalIso } from "../time.js";

function unit(i: number, dim: number): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = 1;
  return v;
}

async function main() {
  const dir = path.resolve("data/lance-smoke");
  fs.rmSync(dir, { recursive: true, force: true });

  const store = await LanceStore.open(dir, "none");
  const dim = 8;
  // 固定时刻（unix 秒），经 helper 转本地 RFC3339，保证任意 TZ 下自洽
  const T_CREATE = 1786363201; // 2026-08-10T20:00:01+08:00
  const T_UPDATE = 1786363202;
  const T_INDEX = 1786363203;
  const rows: ChunkRow[] = [
    {
      chunk_id: makeChunkId("docA", 0),
      doc_id: "docA",
      path: "a.md",
      content_hash: "ha",
      project: "inbox",
      title: "A",
      text: "混合检索与向量",
      vector: unit(0, dim),
      modality: ModalityText,
      chunk_index: 0,
      heading_path: "# A",
      created_at: unixToLocalIso(T_CREATE),
      updated_at: unixToLocalIso(T_UPDATE),
      indexed_at: unixToLocalIso(T_INDEX),
    },
    {
      chunk_id: makeChunkId("docB", 0),
      doc_id: "docB",
      path: "b.md",
      content_hash: "hb",
      project: "inbox",
      title: "B",
      text: "无关内容",
      vector: unit(3, dim),
      modality: ModalityText,
      chunk_index: 0,
      heading_path: "# B",
      created_at: unixToLocalIso(T_CREATE),
      updated_at: unixToLocalIso(T_UPDATE),
      indexed_at: unixToLocalIso(T_INDEX),
    },
  ];
  await store.insertRows(rows);

  const st = await store.statusAsync();
  console.log("status", st);
  if (st.chunks !== 2) throw new Error(`chunks want 2 got ${st.chunks}`);

  const hash = await store.contentHash("docA");
  if (hash !== "ha") throw new Error(`hash ${hash}`);

  let hits = await store.searchExact(unit(0, dim), 10, { project: "inbox", space: "text" });
  hits = aggregateByDocId(hits, 5);
  console.log(
    "hits",
    hits.map((h) => ({ doc: h.doc_id, score: h.score, snip: h.snippet })),
  );
  if (hits[0]?.doc_id !== "docA") throw new Error(`top want docA got ${hits[0]?.doc_id}`);

  // 时间窗：unix 秒入参 → 定宽字符串下推 Lance SQL；窗口夹到同一秒应命中 2 行
  const win = await store.searchExact(unit(0, dim), 10, {
    space: "text",
    updated_after: T_UPDATE,
    updated_before: T_UPDATE,
  });
  if (win.length !== 2) throw new Error(`时间窗应命中 2 行 got ${win.length}`);
  const miss = await store.searchExact(unit(0, dim), 10, {
    space: "text",
    updated_after: T_UPDATE + 1,
  });
  if (miss.length !== 0) throw new Error(`窗口后应命中 0 行 got ${miss.length}`);

  const n = await store.deleteByDocId("docA");
  console.log("deleted", n);
  const st2 = await store.statusAsync();
  if (st2.chunks !== 1) throw new Error(`after delete chunks want 1 got ${st2.chunks}`);

  await store.close();
  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
