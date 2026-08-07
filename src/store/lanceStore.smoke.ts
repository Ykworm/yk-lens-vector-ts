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
      created_at: 1,
      updated_at: 2,
      indexed_at: 3,
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
      created_at: 1,
      updated_at: 2,
      indexed_at: 3,
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
