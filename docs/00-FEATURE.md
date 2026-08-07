# yk-vector-ts — 功能定义（Feature）

| 项 | 内容 |
|----|------|
| **状态** | 权威（TS 实现） |
| **更新** | 2026-08-04 |
| **读者** | 人 + AI 代理 |
| **必读前置** | monorepo [`docs/00-SHARED-IDS.md`](../../docs/00-SHARED-IDS.md) |
| **历史** | 语义继承 `yk-vector-go/docs/00-FEATURE.md` |

---

## 0. 三句话

1. **yk-vector-ts** 只做一件事：把 **已进 vault 的 L1 笔记** 变成 **可搜的向量**（切分 → embed → Lance）。
2. **hybrid 搜索**（关键词 + 向量融合）在 **lensd** 里做，不在本服务。
3. 主键是稳定 **`doc_id`**；**`content_hash` 只用于去重 / 是否重算**。
4. 口径是 **测试版可分期**；**禁止「整篇 1 块」当目标切分**。

---

## 1. 是什么 / 不是什么

### 1.1 是什么

```
lensd 送来一篇笔记正文
    → heading_recursive 切成多 chunk
    → 调 embedding（Qwen3 兼容 HTTP）
    → 写入本机 LanceDB（官方 @lancedb/lancedb）
    → 提供向量 search HTTP
```

### 1.2 不是什么

| 不是 | 谁负责 |
|------|--------|
| Markdown 真源 / vault | lensd |
| 关键词搜索（Meili） | lensd + Meilisearch |
| PDF/图转 MD | yk-coverto-md |
| 产品级 hybrid / RRF | **lensd** |
| 独立 MCP 进程 | 不做；Agent 走 lens-mcp → lensd |

---

## 2. 在系统里站哪

```
Import / Direct write / From Chat(后置)
  → 笔记写入 vault L1
  → lensd :8700 写 Meili + HTTP → yk-vector-ts :8703
  → 搜索：Meili + 本服务 → lensd RRF
```

| 进程 | 端口 | 职责 |
|------|------|------|
| lensd | 8700 | vault、Meili、hybrid、对外 API |
| yk-coverto-md | 8701 | PDF/图 → 沙箱 MD |
| **yk-vector-ts** | **8703** | chunk / embed / Lance / 向量 search |
| （历史）yk-vector-go | 8702 | Go 实现对等服务；迁移期可并存 |

---

## 3. 边界清单

### 3.1 做

| 能力 | 说明 |
|------|------|
| **replace** | 按 `doc_id` 先删后建；可选 `remove_and_insert` 忽略 hash skip |
| **delete** | 按 `doc_id` 删光（幂等） |
| **rename** | 只改 path/title，不重 embed |
| **search** | 服务内 embed；文搜文 / 文搜图 / 图搜图 |
| **chunk** | MD 标题 + 过长 recursive |
| **embed** | 文本 + 可选 VL 跨模态 |
| **Lance 持久化** | 本地目录；启动只 Open |
| **ANN** | 默认 IVF_FLAT + cosine；`none` 精确对照 |
| **healthz / jobs** | 健康检查；异步 replace 任务查询 |

### 3.2 不做

| 非目标 | 原因 |
|--------|------|
| 持有 / 写 vault | 真源在 lensd |
| 写 Meili | 关键词在 lensd |
| 索引 coverto temp | 未进 L1 不索引 |
| 启动扫库 re-embed | 烧钱 |
| 生产前端直连 :8703 | 仅 Dev 测试页可代理 |
| 向量侧独立 CLI reindex | **不做**；运维走 lensd admin + `remove_and_insert`（见 11） |
| 独立 yk-vector-mcp | 不做 |

---

## 4. 谁可以调用

| 从 | 到 | 允许？ |
|----|-----|--------|
| **lensd** | yk-vector-ts | ✅ 唯一生产调用方 |
| 前端 / Agent | yk-vector-ts | ❌ 生产禁止（Dev 页例外） |
| yk-vector-ts | embedding API | ✅ 出站 |
| yk-vector-ts | lensd | ❌ 不回调 |

---

## 5. 何时写入

**只有笔记已以 L1 身份进 vault 之后**，lensd 才调本服务。

| 时机 | 本服务 |
|------|--------|
| coverto 沙箱 temp | 否 |
| vault 写入 L1 成功 | replace |
| L1 内容变（hash 变） | replace（全量重算该 doc） |
| L1 内容不变（hash 同） | **跳过**（防重复处理同一 doc 同一版正文） |
| 删除 L1 | delete |
| 启动 | 只 Open Lance |
| 运维要「同正文也重算」 | 请求里关掉防重复（字段名历史遗留 `remove_and_insert: true`，见 11） |

### 防重复处理（同一 doc）

| 项 | 说明 |
|----|------|
| **规则** | 同一 `doc_id` 且请求里的 `content_hash` 与库内已存一致 → **不**再切分、不调 embedding、不写库 |
| **返回** | `skipped: true`，`reason: content_hash unchanged` |
| **目的** | 笔记保存/同步时 lensd 可能多次触发 replace；**同一版正文只处理一次**，省钱、省时间 |
| **何时仍要重算** | 换 embedding 模型、改切分逻辑、向量损坏——此时由 lensd admin reindex **关闭防重复** 再 replace（见 [11](11-DEFERRED-OPS.md)） |

---

## 6. 数据模型（摘要）

| 字段 | 角色 |
|------|------|
| `doc_id` | replace/delete/rename 主键 |
| `content_hash` | 指纹；skip / remove_and_insert 用 |
| `path` | 冗余；打开真源 |
| `chunk_id` | 行主键：`doc_id#i` 或 `doc_id#img#i` |
| `vector` / `image_vector` | 双空间，禁止混搜 |
| `created_at` / `updated_at` / `indexed_at` | 三时间字段分行 |

切分：**heading_recursive**（见 02）。聚合：search 默认按 `doc_id` 折叠（B5）。  
**切分：** 长节 recursiveSplit；叶子 Enrich **已默认开**（±N 邻域 + meta；`text` 仍为切片）。见 [02-CHUNKING-STATUS](02-CHUNKING-STATUS.md)·[15](15-PARENT-CHILD-AND-ENRICH.md)。  
**collection_id：** 一书多 MD，改动面 [16](16-COLLECTION-ID-IMPACT.md)，未实现。

---

## 7. HTTP 契约

前缀 `/v1`。桌面阶段可不鉴权。

| 方法 + 路径 | 含义 |
|-------------|------|
| `GET /healthz` | 活着？Lance？embedding？vl？chunks？ann？ |
| `POST /v1/index/replace` | 按 `doc_id` **先删后建**；MD 含图时的结果约定见 07 第 5 节 |
| `POST /v1/index/delete` | 按 `doc_id` 删光 |
| `POST /v1/index/rename` | 只改 path/title |
| `POST /v1/index/upsert_text` | 显式文本块入库（简单测试；失败直接 4xx/5xx） |
| `POST /v1/index/upsert_image` | 显式图像入库；可选上传对象存储后 `image_uri` 为 HTTP URL |
| `POST /v1/assets/upload` | 可选：只上传图到 MinIO/OSS，返回可预览 URL |
| `POST /v1/search` | 向量检索 |
| `GET /v1/jobs/:id` | 异步 replace 任务 |
| `GET /v1/admin/tables` | 只读 Lance 表清单（npm 内建 Admin） |
| `GET /v1/admin/rows` | 只读分页扫行（`order_by` / `order` 按标量列排序） |

### replace body（要点）

```json
{
  "doc_id": "01HQ...",
  "path": "inbox/notes/foo.md",
  "content_hash": "a3f2...",
  "project": "inbox",
  "title": "foo",
  "content": "---\n...\n---\n\n正文",
  "created_at": 1720000000,
  "updated_at": 1720001000,
  "remove_and_insert": false,
  "async": false
}
```

### search body（要点）

```json
{
  "query": "混合检索",
  "limit": 50,
  "project": "inbox",
  "updated_after": null,
  "updated_before": null,
  "aggregate": true,
  "mode": "text"
}
```

`mode`：`text` | `text_to_image` | `image_to_image`（见 07 / 12）。

---

## 8. hybrid（lensd）

```
lensd Search(mode=hybrid):
  Meili + POST 本服务 /v1/search → RRF
```

`LENS_VECTOR=http://localhost:8703`（或 go 的 8702）。空/off = degraded 仅关键词。

---

## 9. 配置（示意）

```yaml
addr: ":8703"
lance_path: "data/lance"
vector_index: "ivf_flat"   # none = 精确
embedding:
  base_url: "https://..."
  api_key: "sk-..."          # 本机推荐直接写在 yaml（IDE 可改；文件 gitignore）
  model: "qwen3-embedding-0.6b"
vl:
  base_url: "https://..."
  api_key: ""                # 空则回落 embedding.api_key
  model: "qwen3-vl-embedding"
chunk:
  strategy: "heading_recursive"
  max_tokens: 512
  overlap_tokens: 64
```

桌面阶段**不必**用环境变量配 key；环境变量仅可选覆盖。

---

## 10. 成功标准（本服务）

- [x] 多 chunk；禁止整篇强制 1 块
- [x] replace/delete 按 `doc_id`；hash skip；`remove_and_insert` 可重算
- [x] 启动只 Open，不 re-embed
- [x] 三时间字段 + 时间窗
- [x] 默认文档级聚合
- [x] 真 Lance 目录 + 官方 TS SDK
- [x] 文本表 / 图像表各自向量索引（ANN 开时）
- [ ] 系统级：lensd 默认指向本服务 + Import 全链路验收（接线/运维，见 03 / 10）
