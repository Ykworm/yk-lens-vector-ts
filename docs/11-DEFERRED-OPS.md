# 运维与增强（C-4 / C-5 / C-6 / C-10）

| 项 | 内容 |
|----|------|
| **状态** | C-4 / C-5 / C-6 / C-10 已实现（TS） |
| **更新** | 2026-08-04 |

---

## C-5 运维重算（关闭「防重复处理」）

### 日常：防重复处理同一 doc

正常 replace：

- 键仍是 `doc_id`
- 若 **`content_hash` 与库内相同** → **跳过**（不 embed、不写库）
- 避免保存/同步时对**同一篇同一版正文**重复烧 embedding

### 运维：同正文也要重建向量时

换模型、改切分、向量坏了 → 需要 **关闭防重复** 再走一遍 delete+embed+insert。

| 项 | 内容 |
|----|------|
| **协议字段** | replace body：`remove_and_insert: true`（忽略 content_hash skip，先删后建整篇重建；原名 force） |
| **推荐入口** | lensd `POST /v1/admin/vector/reindex`（扫 L1，对每篇关闭防重复后调本服务） |
| **Dev / 手工** | 实验台或 curl 调 replace，带上关闭防重复 |
| **不做** | 向量进程独立 CLI |

```bash
# 经 lensd（生产运维）
curl -s -X POST localhost:8700/v1/admin/vector/reindex \
  -H 'Content-Type: application/json' \
  -d '{"doc_id":"01HQ...","remove_and_insert": true}'

# 直接打向量服务（调试）：remove_and_insert=true 表示关闭 hash 防重复
curl -s -X POST localhost:8703/v1/index/replace -H 'Content-Type: application/json' -d '{
  "doc_id":"01HQ...","path":"inbox/a.md","content_hash":"same-as-before",
  "content":"# ...","remove_and_insert": true
}'
```

要求：`LENS_VECTOR` 指向本服务、embedding 有 key。  
字段名 **`remove_and_insert`** 即字面意思：先删旧行再 insert；为 true 时不做 content_hash 短路。

---

## C-4 异步 replace

| 方式 | 行为 |
|------|------|
| 请求 `"async": true` | 202 + `job_id` |
| 配置 `replace_async: true` | 默认异步 |
| `GET /v1/jobs/:id` | queued / running / done / failed / skipped |

限制：内存队列，**进程重启任务丢失**。

---

## C-10 rename

```bash
curl -s -X POST localhost:8703/v1/index/rename -H 'Content-Type: application/json' -d '{
  "doc_id":"d1","path":"inbox/notes/new.md","title":"新标题"
}'
```

只改 path/title，**不**重 embed。

---

## C-6 ANN

```yaml
vector_index: "ivf_flat"   # IVF_FLAT + cosine
# vector_index: "none"     # 精确对照
```

- 文本表 `vector`、图像表 `image_vector` **各自**建 IVF_FLAT  
- 详见 [06-LANCEDB-USAGE.md](06-LANCEDB-USAGE.md)

---

## 仍后置

| ID | 说明 |
|----|------|
| C-1 | From Chat |
| C-2 | PDF page |
| C-7 / C-8 | late / rerank |
| optimize 运维节奏 | 大规模写入后可选 |
