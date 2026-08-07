# yk-vector-ts 文档索引

给人读，也给 AI 代理读。约定：

- **短句 + 表格** 优先
- 术语与 monorepo 根目录 [`docs/00-SHARED-IDS.md`](../../docs/00-SHARED-IDS.md) **完全一致**
- 禁止用「§」；章节用「第 N 节」或标题链接
- 改 ID / API 语义时：**先改根词典，再改本目录**

本服务是 **`yk-vector-go` 的 TypeScript 对等实现**（LanceDB **官方** SDK）。HTTP 契约对齐；默认端口 **`:8703`**。

---

## 阅读顺序

```
1. 根目录 docs/00-SHARED-IDS.md
2. 00-FEATURE.md
3. 01-PLAN.md
4. 03-BACKLOG.md          ← 完成度以本表为准
5. 06-LANCEDB-USAGE.md    ← 索引锁定 IVF_FLAT + cosine
6. 07 · 12 · 13 · 14 · **15 Enrich/父子** · **16 collection**
7. 02-CHUNKING-STATUS · 02-DESIGN-DETAIL · 08-TS-LAYOUT
```

| 文件 | 一句话 |
|------|--------|
| [00-FEATURE.md](00-FEATURE.md) | 职责、边界、HTTP、成功标准 |
| [01-PLAN.md](01-PLAN.md) | 分期 T0–T5 |
| [02-DESIGN-DETAIL.md](02-DESIGN-DETAIL.md) | 切分、精确检索、API 细节 |
| [03-BACKLOG.md](03-BACKLOG.md) | **全部任务与完成状态** |
| [06-LANCEDB-USAGE.md](06-LANCEDB-USAGE.md) | **Lance 用法：IVF_FLAT + cosine（已锁定）** |
| [07-MULTIMODAL-VECTOR.md](07-MULTIMODAL-VECTOR.md) | **MD 含图完整流程规格（写代码跟这份）** |
| [08-TS-LAYOUT.md](08-TS-LAYOUT.md) | TS 目录树 + Agent 接入 |
| [09-DEV-TEST-UI.md](09-DEV-TEST-UI.md) | Dev 向量实验台（app 侧） |
| [10-T3-ACCEPTANCE.md](10-T3-ACCEPTANCE.md) | Import / temp / Direct write 验收 |
| [11-DEFERRED-OPS.md](11-DEFERRED-OPS.md) | async · remove_and_insert / reindex · rename · ANN |
| [12-C9-MULTIMODAL.md](12-C9-MULTIMODAL.md) | C-9 实现对照 07 + 债务 |
| [13-OBJECT-STORE-MINIO.md](13-OBJECT-STORE-MINIO.md) | **本机 MinIO / 以后 OSS；image_uri 可预览** |
| [14-LAB-MANUAL-TEST.md](14-LAB-MANUAL-TEST.md) | **实验台手工验收**（文本/图/MD 状态） |
| [15-PARENT-CHILD-AND-ENRICH.md](15-PARENT-CHILD-AND-ENRICH.md) | **Enrich + 父子块设计**（P1/P2，实现未做） |
| [02-CHUNKING-STATUS.md](02-CHUNKING-STATUS.md) | **切分已实现 vs Enrich 规划** |
| [16-COLLECTION-ID-IMPACT.md](16-COLLECTION-ID-IMPACT.md) | **collection_id 全链路改动面** |
| [04-QUERY-INSERT-ALGORITHMS.md](04-QUERY-INSERT-ALGORITHMS.md) | 算法概念（与 go 同源摘要） |
| [05-PRODUCT-VIEW.md](05-PRODUCT-VIEW.md) | 产品视角摘要 |

相关：

| 文件 | 关系 |
|------|------|
| [`docs/00-SHARED-IDS.md`](../../docs/00-SHARED-IDS.md) | 权威 ID 词典 |
| [`yk-vector-go/docs/`](../../yk-vector-go/docs/) | 历史 Go 实现文档（迁移期保留） |

---

## 给 AI 的硬约束

```
- yk-vector-ts is vector-only: chunk + embed + Lance (official TS SDK) + vector search.
- Only lensd may call this service over HTTP. No Agent/frontend direct production access.
- Primary key is doc_id. NEVER use content_hash as identity.
- index/replace and index/delete key on doc_id.
- Do not hold vault; do not write Meili; do not own hybrid RRF (lensd).
- Do not index coverto temp. Do not re-embed entire vault on startup.
- ANN default: IVF_FLAT + cosine (config ivf_flat). none = exact.
- Text and image tables each have their own vector (+ scalar) indexes.
- Multimodal: qwen3-embedding (text) + qwen3-vl-embedding (image); never mix spaces.
- Doc update = delete all rows by doc_id then rebuild (no per-chunk / per-image incremental).
- No product "第几张" image index. MD-with-images: skip failed images, overall ok, report image outcome in response.
- Text vector on image rows = deferred. Design authority: docs/07-MULTIMODAL-VECTOR.md.
- No independent vector MCP; agents use lens-mcp → lensd.
- No MVP wording; whole-doc single vector is not the target chunk strategy.
```
