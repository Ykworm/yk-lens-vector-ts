# yk-lens-vector-ts — HTTP API 文档（人类阅读）

| 项 | 内容 |
|----|------|
| **服务** | yk-lens 向量服务（TypeScript + LanceDB 官方 SDK） |
| **默认地址** | `http://localhost:8703`（lensd 侧 `LENS_VECTOR`） |
| **机器契约** | [openapi.yaml](openapi.yaml)（OpenAPI 3.0.3，可生成客户端 / 喂 coding agent） |
| **权威实现** | [`../src/api/server.ts`](../src/api/server.ts) · [`../src/service/indexService.ts`](../src/service/indexService.ts) |

接口分两类：**业务 API**（`/v1/index` · `/v1/search` · `/v1/jobs` · `/v1/assets`，供上游服务调用）与**管理 API**（`/v1/admin`，只读 + 对账，供运维 / 实验台）。

---

## 0. 端点总表

| 方法 | 路径 | 分类 | 说明 |
|------|------|------|------|
| `GET` | `/healthz` | 健康 | lance / embedding / vl / chunks / ann / object_store |
| `POST` | `/v1/index/replace` | 业务 | 按 `doc_id` 整篇替换（hash skip；`async`→202） |
| `POST` | `/v1/index/upsert_text` | 业务 | 显式文本块入库（测试） |
| `POST` | `/v1/index/upsert_image` | 业务 | 显式图像入库（测试） |
| `POST` | `/v1/assets/upload` | 业务 | 只上传图到 MinIO/OSS，返回可预览 URL |
| `POST` | `/v1/index/delete` | 业务 | 按 `doc_id` 删除全部向量行；不存在也成功 |
| `POST` | `/v1/index/rename` | 业务 | 只改 path / title，不重 embed |
| `POST` | `/v1/search` | 业务 | 文搜文 / 文搜图 / 图搜图 |
| `GET` | `/v1/jobs/:id` | 业务 | 异步 replace 任务 |
| `GET` | `/v1/admin/tables` | 管理 | 只读表清单（rows / dim / indexed） |
| `GET` | `/v1/admin/rows` | 管理 | 只读分页扫行 |
| `POST` | `/v1/admin/prune` | 管理 | 对账：删除不在白名单的行 |

---

## 1. 数据模型速览

两张 Lance 表，双空间双索引：

| 表 | 向量列 | 标量索引 | 用途 |
|----|--------|----------|------|
| `text_chunks` | `vector` | `doc_id` / `project` / `updated_at` | 文搜文 |
| `image_chunks` | `image_vector` | 同上 | 文搜图 / 图搜图 |

- 行主键 `chunk_id`：`doc_id#i`（文本）或 `doc_id#img#<hash>`（图像）。
- 三时间字段 `created_at` / `updated_at` / `indexed_at`：**RFC3339 秒级定宽字符串**（本地时区偏移，字典序 = 时间序）。入参 `created_at` / `updated_at` 仍是 unix 秒，入库边界转换。
- `content_hash` 只做指纹 / skip 判断；身份一律用稳定 `doc_id`。

---

## 2. 端点详解

### 2.1 `GET /healthz`

健康检查。503 = lance 未打开；200 = 打开。

```bash
curl -s localhost:8703/healthz
```

```json
{
  "ok": true,
  "lance": "open",
  "embedding": true,
  "vl": true,
  "chunks": 128,
  "ann": "ivf_flat",
  "object_store": true
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | lance 打开且就绪 |
| `lance` | string | `open` / `closed` |
| `embedding` | boolean | 文本 embedding 已配置 |
| `vl` | boolean | 跨模态 VL embedding 已配置 |
| `chunks` | integer | 当前 chunk 总数 |
| `ann` | string | `ivf_flat` / `none` |
| `object_store` | boolean | 对象存储已就绪（未启用时缺省） |

---

### 2.2 `POST /v1/index/replace`

**按 `doc_id` 整篇替换**：切块 → embed → 先删后建。

- `content_hash` 与库内一致 → **跳过**（`skipped: true, reason: "content_hash unchanged"`），省钱省时间。
- `remove_and_insert: true` → 忽略 skip，强制整篇重建（换模型 / 重排索引用）。
- `async: true` → 入**内存队列**异步执行，立即返回 `202` + `job_id`（进程重启任务丢失，见运维注意）。

```bash
curl -s -X POST localhost:8703/v1/index/replace -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "path": "inbox/notes/foo.md",
  "content_hash": "a3f2...",
  "project": "inbox",
  "title": "foo",
  "content": "---\ndoc_id: 01HQEXAMPLE\n---\n\n# 标题\n\n正文混合检索…",
  "created_at": 1720000000,
  "updated_at": 1720001000,
  "remove_and_insert": false,
  "async": false
}'
```

响应（同步完成）：

```json
{
  "ok": true,
  "skipped": false,
  "doc_id": "01HQEXAMPLE",
  "chunks": 6,
  "text_chunks": 5,
  "image_chunks": 1,
  "images_found": 2,
  "image_skipped": 1,
  "image_errors": []
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 成功 |
| `skipped` | boolean? | hash 未变被跳过 |
| `reason` | string? | skip 原因 |
| `doc_id` | string | 主键 |
| `chunks` | integer | 写入总行数 |
| `text_chunks` | integer? | 文本块数 |
| `image_chunks` | integer? | 成功写入的图像行数 |
| `image_skipped` | integer? | `file_hash` 已入库跳过 VL embed 的图数 |
| `images_found` | integer? | 抽到的附图数（含失败） |
| `image_errors` | string[]? | 附图 embed/入库失败摘要（不拖垮整篇） |
| `job_id` | string? | async 时返回 |
| `status` | string? | async 时为 `queued` |

请求字段（必填带 ★）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` ★ | string | 稳定主键 |
| `path` ★ | string | vault 相对路径 |
| `content_hash` ★ | string | 全文指纹 |
| `project` ★ | string | 项目 |
| `title` ★ | string | 标题 |
| `content` ★ | string | Markdown 正文 |
| `created_at` ★ | integer | unix 秒 |
| `updated_at` ★ | integer | unix 秒 |
| `collection_id` | string | 合集 ID（可选） |
| `collection_title` | string | 合集标题 |
| `collection_ord` | integer | 合集内序号 |
| `remove_and_insert` | boolean | true = 忽略 hash skip |
| `async` | boolean | true = 异步 |

---

### 2.3 `POST /v1/index/upsert_text`

显式文本块入库（测试用；不做切分）。失败直接 4xx/5xx。

```bash
curl -s -X POST localhost:8703/v1/index/upsert_text -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "text": "这一段直接入库",
  "project": "inbox",
  "title": "foo",
  "heading_path": "section>intro"
}'
```

响应 `UpsertResult`：`{ ok, doc_id, chunk_id, modality: "text", replaced, status }`。

请求字段（必填 ★）：`doc_id` ★ · `text` ★；可选 `path` · `project` · `title` · `content_hash` · `chunk_index` · `heading_path` · `created_at` · `updated_at`。

---

### 2.4 `POST /v1/index/upsert_image`

显式图像入库（测试用；VL embed）。`image_base64` / `image_data_url` 至少一个。`image_key` 是稳定键（默认按字节指纹），`file_hash` 为文件本体 sha256（T4 幂等对齐）。

```bash
curl -s -X POST localhost:8703/v1/index/upsert_image -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "image_base64": "<base64>",
  "image_mime": "image/png",
  "alt": "海报",
  "heading_path": "section>海报"
}'
```

响应 `UpsertResult`（modality: `image`；`image_uri` 为可预览 URL 或压碎后的 data 指纹）。

请求字段（必填 ★）：`doc_id` ★；可选 `path` · `project` · `title` · `content_hash` · `alt` · `heading_path` · `image_base64` · `image_mime` · `image_data_url` · `image_key` · `file_hash` · `created_at` · `updated_at`。

---

### 2.5 `POST /v1/assets/upload`

只上传图像到对象存储（MinIO/OSS），返回可预览 URL；**不写 Lance**。

```bash
curl -s -X POST localhost:8703/v1/assets/upload -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "image_base64": "<base64>",
  "image_mime": "image/png"
}'
```

响应：`{ ok, url, key, bucket }`。`image_base64` / `image_data_url` 必填其一；对象存储未启用 → 503。

---

### 2.6 `POST /v1/index/delete`

按 `doc_id` 删除该篇**全部**向量行（text_chunks + image_chunks）；不存在也返回成功（`deleted: 0`），幂等。

```bash
curl -s -X POST localhost:8703/v1/index/delete -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

响应：`{ ok: true, doc_id: "01HQEXAMPLE", deleted: 6 }`。

---

### 2.7 `POST /v1/index/rename`

只改 `path` / `title`，**不重 embed**。

```bash
curl -s -X POST localhost:8703/v1/index/rename -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "path": "inbox/notes/foo-renamed.md",
  "title": "foo-renamed"
}'
```

响应：`{ ok: true, doc_id: "01HQEXAMPLE", updated: 6 }`。

---

### 2.8 `POST /v1/search`

向量检索。三种 mode：

| mode | 行为 | 查询载体 |
|------|------|----------|
| `text` / `text_to_text`（默认） | qwen3-embedding → `text_vector` | `query` |
| `text_to_image` | VL 编文本 → `image_vector` | `query` |
| `image_to_image` | VL 编图 → `image_vector` | `image_base64` / `image_data_url` |

默认按 `doc_id` 聚合（`aggregate: true`，文档级折叠）；`aggregate: false` 返回逐 chunk 结果。`limit` 默认 50，上限 200。

```bash
curl -s -X POST localhost:8703/v1/search -H 'Content-Type: application/json' -d '{
  "query": "混合检索",
  "limit": 20,
  "project": "inbox",
  "mode": "text"
}'
```

响应：

```json
{
  "hits": [
    {
      "doc_id": "01HQ9A3K",
      "path": "inbox/notes/foo.md",
      "content_hash": "a3f2...",
      "chunk_id": "01HQ9A3K#3",
      "chunk_index": 3,
      "score": 0.91,
      "snippet": "正文混合检索…",
      "title": "foo",
      "project": "inbox",
      "heading_path": "section>正文",
      "modality": "text",
      "created_at": "2026-08-10T20:02:13+08:00",
      "updated_at": "2026-08-10T20:02:13+08:00",
      "indexed_at": "2026-08-10T20:02:14+08:00"
    }
  ],
  "total": 1,
  "aggregated": true,
  "mode": "text"
}
```

请求字段：`query`（文本类 mode 必填）· `limit`（1–200，默认 50）· `project` · `updated_after` / `updated_before`（unix 秒，可 null）· `collection_id` · `aggregate`（默认 true）· `mode` · `image_base64` / `image_mime` / `image_data_url`（图搜图）。

命中 `SearchHit` 字段：`doc_id` · `path` · `content_hash` · `chunk_id` · `chunk_index` · `score`（cosine）· `snippet` · `title` · `project` · `heading_path` · `modality` · `image_index` · `image_uri` · `created_at` / `updated_at` / `indexed_at`（RFC3339）· `collection_id` / `collection_title` / `collection_ord`。

---

### 2.9 `GET /v1/jobs/:id`

查询异步 replace 任务。

```bash
curl -s localhost:8703/v1/jobs/job_1
```

响应 `Job`：`{ job_id, kind: "replace", doc_id, status, error?, chunks?, skipped?, created_at, updated_at }`。

`status`：`queued` → `running` → `done` / `failed` / `skipped`。任务不存在 → 404；队列未启用（`replace_async` 未配）→ 503。

---

### 2.10 `GET /v1/admin/tables`

只读表清单。

```bash
curl -s localhost:8703/v1/admin/tables
```

响应：`{ ok: true, tables: [{ name, rows, vector_column, vector_dim, vector_indexed }, ...] }`。

---

### 2.11 `GET /v1/admin/rows`

只读分页扫行。Query 参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `table` | `text_chunks` | `text_chunks` / `image_chunks` |
| `limit` | 20 | 每页行数 |
| `offset` | 0 | 偏移 |
| `doc_id` | — | 按 doc 过滤 |
| `order_by` | — | 标量列名（不能按向量列） |
| `order` | — | `asc` / `desc` |
| `group_by` | — | `doc_id`（默认）等 |

```bash
curl -s "localhost:8703/v1/admin/rows?table=text_chunks&limit=5&order_by=updated_at&order=desc"
```

响应：`{ ok, table, total, offset, limit, order_by, order, group_by, scan_capped?, rows: [...] }`。

---

### 2.12 `POST /v1/admin/prune`

对账清理：删除 `doc_id` 不在 `valid_doc_ids` 白名单里的所有行（text + image）。运维在 `concept-clear` 等操作后用。

```bash
curl -s -X POST localhost:8703/v1/admin/prune -H 'Content-Type: application/json' -d '{
  "valid_doc_ids": ["01HQ9A3K", "01HQ9B2C"]
}'
```

响应：

```json
{
  "ok": true,
  "pruned": 12,
  "docs_removed": 2,
  "tables": {
    "text_chunks": { "pruned": 10, "docs_removed": 2 },
    "image_chunks": { "pruned": 2, "docs_removed": 1 }
  }
}
```

---

## 3. 最小工作流

4 步跑通「写一篇 → 删 → 重命名 → 搜」：

```bash
# 1) 写入（replace）
curl -s -X POST localhost:8703/v1/index/replace -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE", "path": "inbox/notes/foo.md",
  "content_hash": "a3f2...", "project": "inbox", "title": "foo",
  "content": "# 标题\n\n正文混合检索…", "created_at": 1720000000, "updated_at": 1720001000
}'

# 2) 搜索
curl -s -X POST localhost:8703/v1/search -H 'Content-Type: application/json' -d '{
  "query": "混合检索", "limit": 20, "project": "inbox", "mode": "text"
}'

# 3) 重命名
curl -s -X POST localhost:8703/v1/index/rename -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE", "title": "foo-renamed"
}'

# 4) 删除
curl -s -X POST localhost:8703/v1/index/delete -H 'Content-Type: application/json' -d '{"doc_id": "01HQEXAMPLE"}'
```

---

## 4. 错误处理

- 错误统一 `{ ok: false, error: "<message>" }`。
- 400：参数缺失 / 未知 mode / 未知表 / 非法 order_by·group_by / 按向量列排序 / vl 未配置（文搜图）。
- 503：embedding 未配置 / lance 未打开 / object_store 未启用 / 异步队列未启用。
- 500：其它内部错误。

## 5. 运维注意

- **异步 replace 是内存队列**：进程重启任务丢失；重要写入建议 `async: false`。
- **进程独占 `lance_path`**：禁止第二个进程打开同一 Lance 目录。
- `@lancedb/lancedb` 较新：升级需谨慎，改动后跑 `npm run smoke:lance` + 手工搜索验证。
- 密钥写 `configs/yk-lens-vector-ts.yaml`（gitignore）；环境变量可选覆盖。
