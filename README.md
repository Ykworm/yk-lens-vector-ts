<p align="center">
  <img src="./assets/readme/hero.svg" width="100%"
       alt="yk-lens-vector-ts：yk-lens 的向量服务，把 L1 笔记切块、embedding 后写入 Lance 原生目录，提供文本与图像双空间的向量搜索">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="status: active">
  <img src="https://img.shields.io/badge/version-1.0.0-007ec6" alt="version 1.0.0">
</p>

**yk-lens-vector-ts** 是 yk-lens 的向量服务（TypeScript + **LanceDB 官方 SDK**）：把 vault 里的正式笔记（内部简称 **L1**，与沙箱草稿、聊天记录区分）变成可搜的向量——`heading_recursive` 切块 → Qwen3 embedding → 写入本地 Lance 原生目录 → 提供向量搜索 HTTP。

| 要点 | 说明 |
|------|------|
| 端口 | HTTP **`:8703`**；由上游服务调用（前端 / Agent 禁止直连） |
| 主键 | 稳定 **`doc_id`**；`content_hash` 仅做指纹 / 是否重算（skip） |
| 存储 | Lance 本地目录；**启动只 Open，不 re-embed** |
| ANN | **IVF_FLAT + cosine**；文本 / 图像双空间，各自索引 |
| 不做 | 持 vault、写 Meili、hybrid/RRF——都在 lensd 一侧完成 |

---

## 背景：为什么存在

笔记不断积累，关键词只能命中字面相同的片段，搜不到「语义相近」的内容。本服务把每篇笔记切成块、embedding 成向量写入 Lance，让相似语义的片段也能被检索到；笔记附带的图像走同一套存储做跨模态搜索（文搜图 / 图搜图）。

---

## 数据模型

两张 Lance 表、双空间双索引：

| 表 | 向量列 | 标量索引 | 用途 |
|----|--------|----------|------|
| `text_chunks` | `vector` | `doc_id` / `project` / `updated_at` | 文搜文 |
| `image_chunks` | `image_vector` | 同上 | 文搜图 / 图搜图 |

行主键 `chunk_id` = `doc_id#i`（图像行 `doc_id#img#i`）；三时间字段 `created_at` / `updated_at` / `indexed_at` 分行，RFC3339 秒级定宽。表结构细节见 [docs/06](docs/06-LANCEDB-USAGE.md)。

---

## 怎么工作

```
正式笔记写入 vault → 上游服务触发 replace → 切块 → embedding → Lance → 向量搜索
```

<p align="center">
  <img src="./assets/readme/pipeline.svg" width="100%"
       alt="工作机制：lensd 写入成功后触发 replace，heading_recursive 切块，qwen3-embedding 生成文本与图像双空间向量，写入 LanceDB，IVF_FLAT + cosine 向量搜索">
</p>

- 同一 `doc_id` 且请求里的 `content_hash` 与库内一致 → **跳过**，不重复切分 / 调 embedding / 写库（返回 `skipped: true`）。换模型或重排索引时，由上游服务（如 lensd）reindex 时用 `remove_and_insert` 强制重算。
- 搜索的 hybrid（关键词 + 向量融合 / RRF）在上游服务（如 lensd）做，本服务只出向量侧结果。

---

## 快速启动

```bash
cd yk-lens-vector-ts
npm install

cp configs/yk-lens-vector-ts.example.yaml configs/yk-lens-vector-ts.yaml
# 用 IDE 打开 configs/yk-lens-vector-ts.yaml，填 embedding.api_key（及 base_url / model）
# 本机不需要 export 环境变量（文件已 gitignore）

npm run dev            # 开发
# 或
./scripts/dev.sh start # 走脚本
```

验证：

```bash
curl -s localhost:8703/healthz
```

生产构建：

```bash
npm run build
node dist/index.js --config configs/yk-lens-vector-ts.yaml
```

接入上游（示例：yk-lens 的 lensd 指向本服务）：

```bash
export LENS_VECTOR=http://localhost:8703
```

---

## HTTP 契约

📚 **完整 API 文档 → [docs/http-api.md](docs/http-api.md)** · 📜 **OpenAPI 规范 → [docs/openapi.yaml](docs/openapi.yaml)**

- **人类阅读**（http-api.md）：数据模型 / 12 个端点逐一示例与字段表 / 最小工作流 / 错误处理 / 运维注意。
- **机器消费**（openapi.yaml）：OpenAPI 3.0.3 契约，可直接生成客户端或喂给 coding agent。

接口分两类：**业务 API**（`/v1/index` · `/v1/search` · `/v1/jobs` · `/v1/assets`，供上游服务调用）与**管理 API**（`/v1/admin`，只读 + 对账，供运维 / 实验台）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | lance / embedding / vl / chunks / ann |
| `POST` | `/v1/index/replace` | 按 `doc_id` 整篇替换（hash skip；`async`→202） |
| `POST` | `/v1/index/delete` | 按 `doc_id` 删除该篇全部向量行（文本+图像）；不存在也返回成功 |
| `POST` | `/v1/index/rename` | 只改 path/title，不重 embed |
| `POST` | `/v1/search` | 文搜文 / 文搜图 / 图搜图 |
| `GET` | `/v1/jobs/:id` | 异步 replace 任务 |
| `GET` | `/v1/admin/tables` | 只读：表清单（rows / dim / indexed） |
| `GET` | `/v1/admin/rows` | 只读：分页扫行（`table` `limit` `offset` `doc_id` `order_by` `order` `group_by=doc_id`） |

写入一篇笔记：

```bash
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
```

向量搜索：

```bash
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

## 为什么是 TS + Lance

LanceDB **官方一等 SDK** 含 Python / TypeScript / Rust。本服务用 `@lancedb/lancedb` 直接读写 **Lance 原生文件**，避免社区绑定与预编译 CGO 风险。

**为什么存储选 Lance（不只是向量）：**

- **多模态同一存储**：文本向量与图像向量共存在 Lance 表里、各自建索引（`text_vector` / `image_vector`），文搜图 / 图搜图不需要第二套库
- **为「图」留路**：Lance 生态的 [lance-graph](https://github.com/lance-format/lance-graph) 让同一份 Lance 数据可直接做 Cypher 属性图遍历——向量检索与知识图谱检索未来共用一套存储，不另起炉灶
- **开放列式格式**：数据是可移植的 Lance 文件，Python / Rust 生态可以直接读同一份数据

实现要点：只写 Lance 原生格式；ANN 锁定 **IVF_FLAT + cosine**（[docs/06](docs/06-LANCEDB-USAGE.md)）；切分 / HTTP / 多模态按上游约定对齐。

---

## 代码结构

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

## 测试

```bash
npm run test:unit      # node:test：切块 / indexService
npm run smoke:lance    # Lance round-trip 冒烟
npm run typecheck
```

---

## 现状

- **阶段**：yk-lens 桌面阶段现行服务；供上游（lensd）调用，前端 / Agent 一律不直连。
- **版本**：1.0.0（Node ≥ 20）。
- **启动**：仓库根 `./dev.sh start|status|stop` 一键起停（或本仓 `./scripts/dev.sh start`）。
- **端口**：`:8703`，与 yk-lens 其它服务并列——lensd `:8700` · coverto `:8701` · graph `:8702`。
- **数据**：Lance 目录默认 `data/lance`（配置 `lance_path`）；本进程独占数据目录，禁止第二个进程打开同一目录。

---

## Roadmap

后端与产品演进见 [docs/03-BACKLOG.md](docs/03-BACKLOG.md)（勾选清单）；延后运维项（异步队列、对象存储、reindex 流程）见 [docs/11-DEFERRED-OPS.md](docs/11-DEFERRED-OPS.md)。

---

## 已知注意点

- **异步 replace 是内存队列**：进程重启任务丢失（见 docs/11）。
- **进程独占 `lance_path`**：禁止两个进程同时打开同一 Lance 目录。
- **`@lancedb/lancedb` 较新**：升级需谨慎，改动后跑 `smoke:lance` + 手工搜索验证。

---

## 文档

- 本仓 [`docs/`](docs/)（权威，以 [`03-BACKLOG.md`](docs/03-BACKLOG.md) 勾选）
- 根词典 [`docs/00-SHARED-IDS.md`](../docs/00-SHARED-IDS.md)

---

## License

UNLICENSED（未授权；yk-lens 内部组件）。
