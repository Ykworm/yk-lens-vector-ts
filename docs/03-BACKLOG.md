# yk-lens-vector-ts — 全量任务清单

> **状态**：权威完成度表（2026-08-04）  
> **口径**：测试版可分期；不用「MVP」  
> **继承**：`yk-vector-go/docs/03-BACKLOG.md` 任务 ID；状态按 **本 TS 实现** 勾选  

图例：`⬜` 未做 · `🟨` 进行中/接线未验 · `✅` 完成 · `⏸` 后置 · `∅` 不在本仓（在 lensd/app）

---

## A. 跨仓依赖

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| DEP-1 | lensd 稳定 `doc_id` | ✅ | 已在 yk-lens-go |
| DEP-2 | 根词典与实现一致 | ✅ | 共用 00-SHARED-IDS |

---

## B0 骨架

| ID | 任务 | 状态 |
|----|------|------|
| B0-A | 独立 package / 配置 / 默认 `:8703`（树见 [08](08-TS-LAYOUT.md)） | ✅ |
| B0-B | `GET /healthz` | ✅ |
| B0-C | Lance 目录 Open + 完整列（官方 SDK） | ✅ |
| B0-D | 本地启动说明 | ✅ |

---

## B-DEV 前端 Dev 测试页

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| B-DEV-A～D | VectorLab 等 | ∅ / 🟨 | 实现在 **app/**；原指向 go `:8702`。切 ts 时改代理到 **`:8703`**（未改代码则 🟨） |

---

## B1 向量核心

| ID | 任务 | 状态 |
|----|------|------|
| B1-A | embedding 配置（Qwen 兼容 HTTP） | ✅ |
| B1-B | `POST /v1/index/replace`（键 = `doc_id`） | ✅ |
| B1-C | `POST /v1/index/delete` | ✅ |
| B1-D | `POST /v1/search` | ✅ |
| B1-E | heading_recursive 切分 | ✅ |
| B1-F | 行字段 + 三时间字段 | ✅ |
| B1-G | 精确对照路径（`vector_index: none`） | ✅ |
| B1-H | 同 doc_id+content_hash skip | ✅ |
| B1-I | embed 失败不写空向量 | ✅ |

---

## B2 接 lensd

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| B2-A～G | LENS_VECTOR、L1 触发、hybrid、status、单测 | ∅ | **代码在 yk-lens-go，早已完成**；与语言无关 HTTP |
| B2-切换 | 默认/dev 指向 ts `:8703` | ✅ | `dev.sh` + app 代理已切 8703 |

---

## B3 导入路径验收

| ID | 任务 | 状态 | 说明 |
|----|------|------|------|
| B3-A～C | Import / temp / Direct write | ✅ 单测 | `go test ./internal/memory/ -run TestT3_` 已过；手工 E2E 需 embedding key（见 10） |

---

## B4 时间与过滤

| ID | 任务 | 状态 |
|----|------|------|
| B4-A | 三字段行级 + 命中回传 | ✅ |
| B4-B | search 时间窗下推 | ✅ |
| B4-C | Meili + lensd 贯通 | ∅ | lensd |

---

## B5 结果聚合

| ID | 任务 | 状态 |
|----|------|------|
| B5-A | 默认按 doc_id 聚合 | ✅ |
| B5-B | hit 带 chunk_index / snippet / path | ✅ |

---

## C. 后置 / 增强

| ID | 任务 | 状态 | 备注 |
|----|------|------|------|
| C-1 | From Chat | ⏸ | |
| C-2 | PDF page | ⏸ | |
| C-4 | 异步 replace + `GET /v1/jobs/:id` | ✅ | 内存队列；重启丢任务 |
| C-5 | 运维重算（关闭 content_hash 防重复 + lensd admin） | ✅ | 无向量侧 CLI；见 [11](11-DEFERRED-OPS.md) |
| C-6 | ANN：**IVF_FLAT + cosine** 默认开；双表各自索引 | ✅ | 见 [06](06-LANCEDB-USAGE.md)；配置 `ivf_flat` |
| C-7 / C-8 | late / rerank | ⏸ | |
| C-9 | 双空间 + 文搜图/图搜图 | ✅ | 代码齐；**产品决策见 [07](07-MULTIMODAL-VECTOR.md)** |
| C-9b | 显式 `upsert_text` / `upsert_image` | ✅ | 实验台 Upsert 页；07 第 10 节 |
| C-9c | 图行主键用 uri/key hash（不做第几张） | ✅ | `makeImageChunkIdFromKey`；replace + upsert |
| C-9d | 图行挂文字向量 / 描述 embed | ⏸ | 07 第 4.2 节，后置 |
| C-13 | 本机 MinIO + image_uri HTTP 预览 | ✅ | 见 [13](13-OBJECT-STORE-MINIO.md)；以后换 OSS |
| C-14 | 实验台手工验收：文本 / 纯图 / 纯 MD | ✅ | 见 [14](14-LAB-MANUAL-TEST.md) |
| C-14b | 实验台：MD 内嵌图片 replace 闭环 | ⬜ | 14 第 2 节未测；遇到再验 |
| C-15 | 窗口 Enrich：挂**叶子**（recursive 后）；±N + 可选 meta | ✅ | `embedText.ts` + replace/upsert_text；默认 enrich=true |
| C-16 | 父子块：父=整节(不 embed)，子=切片；搜子读父 | ⬜ | [15](15-PARENT-CHILD-AND-ENRICH.md) 第 2 节；人读默认可 doc_id |
| C-17 | collection_id 全链路（书/合集） | 🔵 已排期 | [16-COLLECTION-ID-IMPACT.md](16-COLLECTION-ID-IMPACT.md)；穿透 lensd/Meili/vector/app；需求定案 2026-08-06，见 `yk-lens-go/docs/01-PLAN.md` Step 19 |
| C-10 | `POST /v1/index/rename` | ✅ | |
| C-11 | 启动 backfill | ⏸ | 明确不做 |
| C-12 | 旧 ingest UI | ⏸ | |

---

## D. 文档

| ID | 任务 | 状态 |
|----|------|------|
| D-ts | 本目录 TS 权威文档 | ✅ | 本仓 `docs/` |
| D-go-archive | go 文档保留为历史 | ✅ | `yk-vector-go/docs/` 迁移期不删 |

---

## 汇总（本服务交付）

| 集合 | 结论 |
|------|------|
| B0 + B1 + B4-A/B + B5 | ✅ 完成 |
| C-4 / C-5 / C-6 / C-9 / C-10 | ✅ 完成（口径见 06 / 11） |
| B2 代码 | ∅ 在 lensd 已完成 |
| B2 默认切 ts + B3 验收 + B-DEV 代理 | 🟨 删 go 前建议收口 |

---

## 阅读

- 功能 → [00-FEATURE.md](00-FEATURE.md)  
- Lance → [06-LANCEDB-USAGE.md](06-LANCEDB-USAGE.md)  
- 分期 → [01-PLAN.md](01-PLAN.md)  
