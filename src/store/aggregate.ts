import type { SearchHit } from "../types.js";

/** 按 doc_id 折叠：保留每个文档最高分 chunk（输入须已按 score 降序） */
export function aggregateByDocId(hits: SearchHit[], limit: number): SearchHit[] {
  if (hits.length === 0) return hits;
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (!h.doc_id || seen.has(h.doc_id)) continue;
    seen.add(h.doc_id);
    out.push(h);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}
