# yk-vector-ts — 设计细节

| 项 | 内容 |
|----|------|
| **先读** | [00-FEATURE](00-FEATURE.md) · 根词典 00-SHARED-IDS |
| **更新** | 2026-08-04 |

---

## 1. ID

| 名字 | 角色 |
|------|------|
| `doc_id` | 稳定身份；replace/delete 键 |
| `content_hash` | 正文指纹；skip / remove_and_insert |
| `path` | 打开真源（冗余） |
| `chunk_id` | `doc_id#index` 或 `doc_id#img#index` |

本服务 **不发** doc_id，只接收 lensd 传入。

---

## 2. Lance 与 vault

```
vault md (lensd)
  doc_id / path / content_hash
       │ HTTP replace body.content
       ▼
Lance 多行 chunk（本服务）
  同 doc_id；冗余 path
```

本服务默认 **不读** vault 磁盘。

---

## 3. replace 流程

```
if !remove_and_insert && hash 未变 → skip
if async → 入队 202
else:
  delete by doc_id
  chunk(content)
  embed 每块 → text 行
  可选抽图 + VL → image 行
  insert
```

**MD 含图的完整步骤、返回字段、三种 URI、失败语义**：以 [07-MULTIMODAL-VECTOR.md](07-MULTIMODAL-VECTOR.md) 为准（写代码跟 07，不要只看本节骨架）。

---

## 4. Chunk：heading_recursive

1. 去 frontmatter  
2. 按 `#`…`######` 切节，维护 heading_path  
3. 单节超 `max_tokens` → recursive（段落/句/硬切）  
4. 禁止以「整篇 1 向量」为验收目标  

实现：`src/chunk/headingRecursive.ts`。

**现状：**  
- 长节再切：**已做**（`recursiveSplit` 段→句→硬切+overlap）→ 见 [02-CHUNKING-STATUS.md](02-CHUNKING-STATUS.md)  
- embed 用**叶子切片** `text`，**不做**入库摘要、**尚未**做邻域 Enrich  

**已设计、准备实现：**  
- 叶子 Enrich（±N + 可选 meta）→ [15](15-PARENT-CHILD-AND-ENRICH.md) C-15  
- 节级父子 → 15 C-16（后置）  
- 一书多 MD → [16-COLLECTION-ID-IMPACT.md](16-COLLECTION-ID-IMPACT.md)

---

## 5. 精确检索 vs ANN

| 配置 | 行为 |
|------|------|
| `none` | 无向量 ANN / bypass；精确余弦路径 |
| `ivf_flat` | IVF_FLAT + cosine 加速 |

命中 score：由距离换算（cosine distance → `1 - d` 等，见 store）。

---

## 6. 聚合

search 默认 `aggregate=true`：同 `doc_id` 只留最高分 chunk 为代表。  
`aggregate=false` 返回原始 chunk 行（调试）。

---

## 7. AI 硬约束

- 主键 doc_id；hash 不作身份  
- 不持 vault；不做 hybrid  
- 双空间禁止混用  
- 文本/图像表各自索引（ANN 开时）  
