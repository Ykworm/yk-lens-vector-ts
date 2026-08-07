# yk-vector-ts — LanceDB 使用方案（已锁定）

| 项 | 内容 |
|----|------|
| **状态** | **已定**（2026-08-04，TS 官方 SDK） |
| **权威范围** | 本服务如何用 LanceDB |
| **SDK** | `@lancedb/lancedb`（官方 TypeScript） |
| **相关** | [02](02-DESIGN-DETAIL.md) · [07](07-MULTIMODAL-VECTOR.md) · [03](03-BACKLOG.md) C-6 / C-9 |

> 原则：结论落在本文件；其它文档只引用。

---

## 0. 一句话

**嵌入式 Lance 本地目录；距离度量 cosine；生产默认向量索引 = IVF_FLAT（无 PQ 量化）+ cosine；文本表与图像表各自建索引；`none` = 精确扫描对照。**

---

## 1. 已定决策总表

| 维度 | 锁定选择 | 不选 / 说明 |
|------|----------|-------------|
| 部署 | **嵌入式 OSS**，`lance_path` | 不绑 Cloud 必选 |
| SDK | **官方 TypeScript** `@lancedb/lancedb` | 不用 Go CGO 社区绑定 |
| 距离 | **`cosine`**（建索与 search 同一 metric） | 默认不用 l2 |
| 表 | **`text_chunks`** + **`image_chunks`** 分表 | 维数可独立 |
| 文本向量列 | `vector`（逻辑 text_vector） | |
| 图像向量列 | `image_vector` | C-9 |
| **生产默认 ANN** | **`IVF_FLAT` + `cosine`** | **无量化**，个人库优先召回/简单 |
| 配置名 | **`ivf_flat`** | 无需与 go 的 `ivf_hnsw_flat` 同名 |
| 精确对照 | `vector_index: "none"` → bypass / 无 ANN | 验收用 |
| 标量索引 | `doc_id` BTree；`project` Bitmap；`updated_at` BTree | **每张表各自建** |
| 向量索引 | **文本列、图像列各自** `createIndex` | **必须**；不是「只建一张表」 |
| 写入 | 按 `doc_id` 整篇 replace（先删后插） | |
| 启动 | 只 Open；不 re-embed | |

### 为何是 IVF_FLAT 而不是文档旧名 IVF_HNSW_FLAT

| 点 | 说明 |
|----|------|
| 目标语义 | **无 PQ/无 SQ 量化**的近似近邻 + **cosine**，个人库召回稳、实现简单 |
| TS 官方 SDK | 提供 `Index.ivfFlat({ distanceType: "cosine" })`，**一等支持** |
| IVF_HNSW_FLAT | Lance 概念类型；TS SDK **无同名工厂**；不必为名字硬绑不可用 API |
| 误写 `ivf_hnsw_flat` | 仍映射到 IVF_FLAT（兼容），**示例与文档默认写 `ivf_flat`** |

**产品结论：无量化 IVF-Flat + cosine = 本仓锁定的生产 ANN。**

---

## 2. 分期与行为

| 模式 | 行为 |
|------|------|
| `ivf_flat`（默认） | 写入后对 `vector` / `image_vector` 建 **IVF_FLAT + cosine**（行数过少可能延后成功） |
| `none` | 不建向量 ANN；search `bypassVectorIndex` 或等价精确路径 |

检索：cosine 近邻；可选 where（project / 时间窗）。

---

## 3. 双表双索引（硬要求）

```
text_chunks.vector        →  IVF_FLAT(cosine)   # 文搜文
image_chunks.image_vector →  IVF_FLAT(cosine)   # 文搜图 / 图搜图
```

| 表 | 标量索引 | 向量索引列 |
|----|----------|------------|
| `text_chunks` | doc_id / project / updated_at | **`vector`** |
| `image_chunks` | 同上 | **`image_vector`** |

禁止：只给文本建 ANN、图像表裸扫当「做完了」。

---

## 4. 参数起点（IVF_FLAT）

| 参数 | 起点 | 说明 |
|------|------|------|
| `distanceType` | `cosine` | 与 search 一致 |
| `numPartitions` | SDK 默认 / 随行数 | 个人库可很小 |

查询：`vectorSearch(...).column(...).distanceType("cosine")`。

---

## 5. 运维注意

| 项 | 规定 |
|----|------|
| optimize | 大规模频繁写入后可运维 `optimize`（后置增强；非阻塞发版） |
| 与 go 同目录 | **禁止** go/ts 同时写同一 `lance_path` |
| 换模型 | lensd admin reindex + replace **`remove_and_insert: true`**（见 11） |

---

## 6. 英文摘要

```
- Embedded Lance via official @lancedb/lancedb.
- Default ANN: IVF_FLAT + cosine (no PQ). Config: ivf_flat.
- none = exact / bypass vector index.
- Separate tables text_chunks + image_chunks; each gets scalar + vector indexes.
- cosine for build and search; dual spaces never mixed.
```
