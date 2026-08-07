# 切分现状与 Enrich 准备（权威）

| 项 | 内容 |
|----|------|
| **日期** | 2026-08-04 |
| **代码** | `src/chunk/headingRecursive.ts` |
| **Enrich/父子** | [15-PARENT-CHILD-AND-ENRICH.md](15-PARENT-CHILD-AND-ENRICH.md) |
| **书/合集** | [16-COLLECTION-ID-IMPACT.md](16-COLLECTION-ID-IMPACT.md) |

---

## 1. 长节会不会再切？——**会，而且已经在做**

对「最底层标题下的正文」：

| 步骤 | 有没有做 | 作用 |
|------|----------|------|
| 按 `#`…`######` 切节 | ✅ **已做** | 得到带 `heading_path` 的节 |
| 节 ≤ `max_tokens` | ✅ **已做** | 整节 = 一块，直接 embed |
| 节 > `max_tokens` | ✅ **已做** | **`recursiveSplit`**：段落 → 换行 → 句读 → 空格 → **硬切**；带 **overlap** |
| 防死递归 | ✅ **已做** | depth 上限 + `hardSplitRunes` |

因此：

> **「长节一定会再切」——对，有效的就是 `recursiveSplit` 这一支；不是规划，是现行代码。**

缺的不是「再切」，而是切完之后的 **Enrich（邻域±N + 可选元数据）** 和可选的 **节级父块**。

---

## 2. recursiveSplit 在链路上的位置

```text
MD
 └─ strip frontmatter
 └─ splitByHeadings          ← 节 + heading_path
      └─ 对每个节:
           ├─ 短 → piece（叶子）
           └─ 长 → recursiveSplit → 多个 piece（叶子）
                段落 → 句子 → 硬切 + overlap
 └─ 【规划】对每个叶子 buildEmbedInput(±N, meta)
 └─ embed(叶子或 enrich 串) → vector
 └─ 存库 text = 叶子 core（切片本身）
```

**对超长正文，最有效的控长手段 = recursiveSplit（已有）。**  
**对切片语义完整、少「断章」= Enrich 挂在叶子上（规划）。**

---

## 3. Enrich：已实现（C-15）

| 问题 | 答案 |
|------|------|
| 挂在哪一层？ | **叶子切片**（recursive 之后） |
| 是否已实现？ | **是** · `src/chunk/embedText.ts` · replace / upsert_text |
| 配置 | `chunk.enrich`（默认 true）、`enrich_neighbor_chars`（256）、`enrich_meta`、`enrich_max_chars` |
| 做什么？ | `window = 前N + 切片 + 后N` + 可选 meta → embed；**库内 text 仍只存切片** |
| 不做什么？ | 不把整篇 MD 塞进每个 embed；不做默认 LLM 摘要；不是 late chunking |

换 enrich 逻辑后已有笔记需 `remove_and_insert` reindex。

---

## 4. 节级父块（可选，非再切）

| 问题 | 答案 |
|------|------|
| 是不是再切？ | **不是**；是「长节已切成多片」时多存一个 **整节 parent 行供阅读** |
| 已实现？ | **否** → C-16 |
| 与 doc_id？ | 人读默认 **整篇 doc**；父块给 Agent 控上下文时用 |

---

## 5. 和「一书多 MD」的边界

- **篇内**超长：recursiveSplit ✅ + Enrich C-15  
- **多篇**一书：`collection_id` → 16，与切分正交  

---

## 6. 实现顺序（文档冻结）

| 序 | 项 | 状态 |
|----|-----|------|
| 1 | recursiveSplit 长节再切 | ✅ 已有 |
| 2 | 叶子 Enrich（±N + meta） | ✅ C-15 已实现（`chunk.enrich` 可关） |
| 3 | collection_id 全链路 | ⬜ 见 16 |
| 4 | 节级 parent-child | ⬜ C-16 后置 |
