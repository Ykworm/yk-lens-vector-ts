# yk-vector-ts

**一句话**：给 lensd 用的 **向量库服务**（TypeScript + **LanceDB 官方 SDK**）——切块、embedding、写入本地 Lance 原生目录、向量搜索。

HTTP 契约与 [`yk-vector-go`](../yk-vector-go/) **对齐**，可替换使用。

---

## 为什么是 TS

LanceDB **官方一等 SDK** 含 Python / TypeScript / Rust；Go 仅社区 CGO。  
本服务用 `@lancedb/lancedb` 直接读写 **Lance 原生文件**，避免预编译 CGO 与社区绑定风险。

---

## 先记住

| 要点 | 说明 |
|------|------|
| 默认端口 | **`:8703`**（go 版 `:8702`；可用 `YK_VECTOR_ADDR` 改成 8702 做切换） |
| 谁可以调 | **只有 lensd**（HTTP）。前端 / Agent **禁止**直连 |
| 真源 | Markdown 在 vault，由 lensd 管；本服务 **不持 vault** |
| 主键 | **`doc_id`**（稳定 ID）。`content_hash` 仅指纹 / skip |
| 存储 | Lance 本地目录（`lance_path`）；启动只 Open，不 re-embed |
| ANN | **IVF_FLAT + cosine**（配置 `ivf_flat`）；文本/图像表各自索引 |
| 权威文档 | [`docs/`](docs/)（以 [`03-BACKLOG.md`](docs/03-BACKLOG.md) 勾选） |

---

## 快速启动

```bash
cd yk-vector-ts
npm install

cp configs/yk-vector-ts.example.yaml configs/yk-vector-ts.yaml
# 用 IDE 打开 configs/yk-vector-ts.yaml，填 embedding.api_key（及 base_url / model）
# 本机不需要 export 环境变量

npm run dev
# 或
./scripts/dev.sh start
```

生产构建：

```bash
npm run build
node dist/index.js --config configs/yk-vector-ts.yaml
```

**密钥**：写在 `configs/yk-vector-ts.yaml` 的 `embedding.api_key`（该文件已 gitignore）。  
环境变量**可选**（覆盖 yaml）；日常用鼠标 / IDE 改 yaml 即可，不必碰 shell。

lensd 切换：

```bash
export LENS_VECTOR=http://localhost:8703
```

---

## HTTP（与 go 相同）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | lance / embedding / vl / chunks / ann |
| `POST` | `/v1/index/replace` | 按 `doc_id` 整篇替换（hash skip；`async`→202） |
| `POST` | `/v1/index/delete` | 按 `doc_id` 删光（幂等） |
| `POST` | `/v1/index/rename` | 只改 path/title，不重 embed |
| `POST` | `/v1/search` | 文搜文 / 文搜图 / 图搜图 |
| `GET` | `/v1/jobs/:id` | 异步 replace 任务 |
| `GET` | `/v1/admin/tables` | 只读：表清单（rows / dim / indexed） |
| `GET` | `/v1/admin/rows` | 只读：分页扫行（`table` `limit` `offset` `doc_id` `order_by` `order` `group_by=doc_id`） |

```bash
curl -s localhost:8703/healthz

curl -s -X POST localhost:8703/v1/index/replace -H 'Content-Type: application/json' -d '{
  "doc_id": "01HQEXAMPLE",
  "path": "inbox/notes/foo.md",
  "content_hash": "a3f2...",
  "project": "inbox",
  "title": "foo",
  "content": "---\ndoc_id: 01HQEXAMPLE\n---\n\n# 标题\n\n正文混合检索…",
  "created_at": 1720000000,
  "updated_at": 1720001000
}'

curl -s -X POST localhost:8703/v1/search -H 'Content-Type: application/json' -d '{
  "query": "混合检索",
  "limit": 20,
  "project": "inbox",
  "mode": "text"
}'
```

Search `mode`：

| mode | 行为 |
|------|------|
| `text` / `text_to_text`（默认） | qwen3-embedding → `text_vector` |
| `text_to_image` | VL 编文本 → `image_vector` |
| `image_to_image` | VL 编图 → `image_vector` |

---

## 目录

```text
src/
  index.ts              # 入口
  config.ts             # YAML + env
  types.ts              # ChunkRow / SearchHit
  api/server.ts         # Express HTTP
  chunk/headingRecursive.ts
  embed/client.ts       # 文本 embedding
  embed/vl.ts           # 跨模态
  image/extract.ts      # MD 抽图
  store/lanceStore.ts   # Lance 官方 SDK
  store/aggregate.ts    # 文档级折叠
  service/indexService.ts
  service/jobs.ts       # 异步 replace
configs/
scripts/dev.sh
```

---

## 与 yk-vector-go 对照

| 项 | go | ts（本仓） |
|----|----|------------|
| Lance 访问 | 社区 CGO `lancedb-go` | **官方** `@lancedb/lancedb` |
| 默认端口 | 8702 | **8703** |
| 逃生 exact/gob | 有 | **无**（只 Lance） |
| ANN | 进程内 HNSW / CGO 映射 | **锁定 IVF_FLAT + cosine**（[docs/06](docs/06-LANCEDB-USAGE.md)） |
| 切分 / HTTP / 多模态 | 有 | **对齐** |
| 文档 | `yk-vector-go/docs` | **`yk-vector-ts/docs`（权威）** |

数据目录不要与 go 实例 **同时写同一 `lance_path`**。能否删 go：见 [docs/99-VS-GO-AND-DELETE.md](docs/99-VS-GO-AND-DELETE.md)。

---

## 设计权威

- 本仓 [`docs/`](docs/)（优先）
- 根词典 [`docs/00-SHARED-IDS.md`](../docs/00-SHARED-IDS.md)
- 历史 go 文档：`yk-vector-go/docs/`（迁移期保留）
