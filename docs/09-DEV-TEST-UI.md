# Dev 向量实验台

| 项 | 内容 |
|----|------|
| **实现位置** | `app/src/dev/`（非本仓代码树，在 monorepo `app/`） |
| **原则** | 仅 DEV；release 不发布 |
| **手工验收** | [14-LAB-MANUAL-TEST.md](14-LAB-MANUAL-TEST.md) |

---

## 1. 入口结构

| 顶栏 | 内容 |
|------|------|
| **LanceDB Viewer + Searcher**（默认） | 全部 Lance 操作：浏览 / 搜索 / Upsert 文图 / MD replace / 删除 |
| **Health / hybrid** | `GET /healthz` · lensd hybrid 对照（非 Lance 直连） |

代理：Vite `/dev-vector` → **`http://localhost:8703`**。  
启动：仓库根 `./dev.sh start`（含 MinIO 可选）或 `yk-lens-vector-ts` 下 `npm run dev`。

产品「检索」页（lensd hybrid）**不**承担图搜图；多模态验收只在实验台。

---

## 2. Lance 页 tabs

| Tab | 能力 |
|-----|------|
| **浏览** | `GET /v1/admin/tables` · `rows`；行内：复制 / 过滤 / **修改**（rename）/ 去写 / **删除**（按 doc_id）；http 图缩略图可点放大 |
| **搜索** | `text` / `text_to_image` / `image_to_image`；命中显示 doc_id；缩略图可点放大 |
| **Upsert 文/图** | `upsert_text` · `upsert_image`；雪花 doc_id；object_store 时图上传 MinIO |
| **MD replace** | 整篇 replace（heading_recursive）+ rename + 页内 delete |

doc_id：雪花十进制（`app/src/dev/snowflake.ts`，对齐 lensd idgen）。

---

## 3. 图与对象存储

| 项 | 说明 |
|----|------|
| 前提 | Health：`vl=true`；预览建议 `object_store=true` |
| 设计 | [13-OBJECT-STORE-MINIO.md](13-OBJECT-STORE-MINIO.md) |
| `image_uri` | 优先 `http://127.0.0.1:9000/yk-lens/...`；前端仅渲染 data / http(s) |
| 闭环 | Upsert 图 → 浏览 image_chunks → 文搜图 / 图搜图 |

相对路径 / 磁盘绝对路径：**不能**直接当 `<img src>`，须 HTTP URL（MinIO/OSS 或静态服务）。

---

## 4. 手工验收口径（摘要）

| 场景 | 状态（2026-08-04） |
|------|-------------------|
| 纯文本 upsert_text | ✅ |
| 纯图片 upsert_image | ✅ |
| 纯 MD replace（无附图） | ✅ |
| MD 内嵌图片 replace | ⬜ 未测，遇到再测 |

细节勾选表见 [14-LAB-MANUAL-TEST.md](14-LAB-MANUAL-TEST.md)。

---

## 5. Browse 与 Docker viewer

| 项 | 说明 |
|----|------|
| **结论** | **不用 Docker 起 lance-data-viewer**；Admin 在 yk-lens-vector-ts |
| **API** | `GET /v1/admin/tables` · `GET /v1/admin/rows`（支持 `order_by` + `order`） |

---

历史参考：`yk-vector-go/docs/09-DEV-TEST-UI.md`（端口改为 8703）。
