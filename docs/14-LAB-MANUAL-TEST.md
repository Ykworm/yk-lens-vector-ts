# 实验台手工验收记录

| 项 | 内容 |
|----|------|
| **日期** | 2026-08-04 |
| **入口** | 向量实验台 → **LanceDB Viewer + Searcher**（默认） |
| **服务** | yk-lens-vector-ts `:8703` · 可选 MinIO `:9000` · lensd hybrid 对照另页 |
| **设计** | [07-MULTIMODAL-VECTOR.md](07-MULTIMODAL-VECTOR.md) · [13-OBJECT-STORE-MINIO.md](13-OBJECT-STORE-MINIO.md) · [09-DEV-TEST-UI.md](09-DEV-TEST-UI.md) |

---

## 0. 一句话

**纯文本、纯图片、纯 MD（无附图）已手工测通；MD 内嵌图片（`![](...)` + replace 抽图）尚未测，遇到再验。**

---

## 1. 环境前提

| 检查 | 期望 |
|------|------|
| `GET /healthz` | `ok` · `lance=open` · `embedding=true` |
| 文搜图 / 图入库 | `vl=true` |
| 图 HTTP 预览 | `object_store=true`（MinIO 已起；`./dev.sh start`） |
| doc_id | 雪花十进制；实验台「雪花生成」 |

---

## 2. 验收矩阵（本轮）

| 场景 | 操作入口 | 期望 | 状态 |
|------|----------|------|------|
| **纯文本** | Upsert 文 → `upsert_text` | `text_chunks` 有行；`vector_dim` 有值；文搜文可命中 | ✅ 已测 OK |
| **纯图片** | Upsert 图 → `upsert_image` | `image_chunks` 有行；`image_uri` 为 `http://…`（MinIO）时可预览；文搜图 / 图搜图可命中 | ✅ 已测 OK |
| **纯 MD（无附图）** | MD replace · 多标题正文 | 多 `chunk_index`；`heading_path` 有值（含 `(intro)`）；文搜文可命中 | ✅ 已测 OK |
| **MD 内嵌图片** | MD replace · content 含 `![](data:…)` 或可拉 URL | 同 doc 既有 text 行又有 image 行；图失败写 `image_errors` 且整体可 ok；文搜图可命中附图 | ⬜ **未测**（遇到再测） |

---

## 3. 各场景怎么验（备忘）

### 3.1 纯文本

1. **Upsert 文/图** → ① 文本  
2. 雪花 doc_id · 填 text → POST upsert_text  
3. **浏览** `text_chunks` · 过滤 doc_id  
4. **搜索** 文搜文  

### 3.2 纯图片

1. **Upsert 文/图** → ② 图像 · 选文件  
2. Health `object_store=true` 时 `image_uri` 应为 MinIO URL  
3. **搜索** 文搜图 / 图搜图；缩略图可点放大  

### 3.3 纯 MD（heading_recursive）

1. **MD replace** · content 含 `#` / `##`（`#` 后有空格）  
2. 可勾 `remove_and_insert` 强制重建  
3. **浏览**：多行 + 非空 `heading_path`（前言为 `(intro)`）  

### 3.4 MD 内嵌图片（待测清单）

1. content 示例：

```markdown
# 标题

一段正文。

![说明](data:image/png;base64,...)
```

或 MinIO/http 图 URL。

2. POST replace 后看返回：`text_chunks` / `images_found` / `image_chunks` / `image_errors`  
3. 浏览：同 doc_id 下 text 表与 image 表都有行  
4. 文搜图 / 图搜图能命中该图  
5. 相对路径图：应 skip 并出现在 `image_errors`（本服务不持 vault）  

---

## 4. 相关 UI 能力（已落地）

| 能力 | 说明 |
|------|------|
| 浏览 · 修改 | 按 doc_id rename path/title |
| 浏览 · 删除 | 按 doc_id 整篇删 text+image（确认框） |
| 搜索 · 缩略图放大 | 点击放大，Esc / 遮罩关闭 |
| 雪花 doc_id | 与 lensd idgen 对齐 |

---

## 5. 非本轮范围

| 项 | 说明 |
|----|------|
| lensd 生产 hybrid 默认文搜图 | 不做 |
| 图行文字向量 | 后置（07） |
| 真阿里云 OSS | 换配置即可；见 13 |

---

## 6. 修订

| 日期 | 说明 |
|------|------|
| 2026-08-04 | 初版：文本 / 纯图 / 纯 MD ✅；MD+图 ⬜ |
