# 上下文 Enrich 与父子块（设计）

| 项 | 内容 |
|----|------|
| **状态** | Enrich **C-15 已实现**（2026-08-04）；父子 C-16 / collection C-17 未做 |
| **动机** | Enrich 曾口头对齐未落文档；纠正误解；父子逐步例；与 recursiveSplit 关系见 [02-CHUNKING-STATUS](02-CHUNKING-STATUS.md) |
| **相关** | [02-CHUNKING-STATUS](02-CHUNKING-STATUS.md) · [16-COLLECTION](16-COLLECTION-ID-IMPACT.md) · [07](07-MULTIMODAL-VECTOR.md) |

---

## 0. 现状（已实现）

```text
MD → heading_recursive 切块
   → 每块 text = 切片本身
   → embed(切片) → vector
   → 命中用该切片 text
```

无 ±N 邻域、无 title/path 进 embed、无 parent 行。

---

## 1. 上下文 Enrich（对齐正确语义）

### 1.1 先澄清误解

| 说法 | 对不对 |
|------|--------|
| `vector = embed(标题 + path + 章节 + **整篇 MD**)` | **不对**，太贵，也不是 enrich |
| `vector = embed(标题 + path + 章节 + **本切片全文**)` | 常见「元数据前缀 enrich」；切片本身必须参与语义，否则向量与块内容无关 |
| `vector = embed(标题 + path + 章节 + **切片前 N 字 + 切片 + 切片后 N 字**)` | **本仓应对齐的会话结论**（窗口 enrich） |
| Late chunking | **另一回事**（见第 1.4 节） |

**资源：**  
- 不会把**整篇笔记**都喂进每个 chunk 的 embed。  
- 每个 chunk 的 embed 输入 ≈ 元数据前缀 + **窗口**（中心是本切片，两侧各最多 N 字），总长有 cap。

库内字段：

| 字段 | 存什么 |
|------|--------|
| `text` | **仅本切片**（展示、snippet、给模型时可再 expand 父块） |
| `vector` | embed(**enrich 串**) |

### 1.2 窗口 enrich 怎么做（逐步）

记号：全文字符串 `Body`（去 frontmatter 后）。  
某切片在 Body 里字符区间 `[start, end)`（实现时用偏移；若难求可用节内相对偏移）。

```text
N = chunk.enrich_neighbor_chars   # 如 200～400 字符，可配置
left  = Body[max(0, start-N) : start]
core  = Body[start:end]            # 即本切片 = 将来存库的 text
right = Body[end : min(len, end+N)]

window = left + core + right       # 邻域上下文，不是整篇
```

再拼元数据（你认可的部分）：

```text
embed_input =
  文档：{title}          # 可关
  路径：{path}            # 可关
  章节：{heading_path}    # 建议开
  ---
  {window}
```

```text
vector = embed(embed_input)
text   = core                 # 只存切片，不存 left/right 进 text 列
```

**为何还要 core（切片）在 window 中间？**  
向量要代表「这一块在说什么」。若只 embed(left+right) 或只 embed(标题)，检索会对不齐块内容。  
贵的是 **整篇重复 embed**，不是「切片自身」——切片本来就要 embed。

### 1.3 配置草案

```yaml
chunk:
  enrich: true
  enrich_neighbor_chars: 256    # 前后各最多 N 字符；0 = 不做邻域，仅元数据+切片
  enrich_meta: true             # title / path / heading_path
  enrich_max_chars: 4000        # embed_input 总 cap，超出优先砍 right，再砍 left
```

### 1.4 邻域 enrich 会不会「不该命中的块被搜到」？

会有这种风险，但通常是 **轻度串味**，不是逻辑错误。

| 现象 | 原因 |
|------|------|
| 查询词只出现在切片 A 末尾 | 切片 B 的 **left 邻域** 含 A 的尾巴 → B 的向量也沾一点 A |
| 用户觉得 B「不该中」 | 向量空间里 B 与 query 仍可能有中等相似度 |

| 控制手段 | 说明 |
|----------|------|
| **N 别太大** | `enrich_neighbor_chars` 256 量级通常够用 |
| **看 score、设门槛** | 实验台「最低 score」前端过滤；产品可 `min_score` 服务端过滤 |
| **rerank**（后置） | 用交叉编码器只对 top-k 精排，压串味 |
| **展示仍用 core** | snippet 只显示本切片，不显示 left/right |
| **父子 expand** | 读父节时人眼可判断是否误召 |

**不是**「enrich 就一定要上摘要」；摘要更容易把别的主题揉进当前块。

### 1.5 和 Late chunking 的区别

| | 窗口 Enrich（我们说的） | Late chunking |
|--|------------------------|---------------|
| 做法 | **每个切片**单独调一次 embedding API，输入=邻域窗口(+元数据) | **整篇**（或很长）过长上下文模型，再按 token 边界 **切向量** |
| API 次数 | 约 = chunk 数 | 约 = 文档数（模型要支持长上下文） |
| 实现 | 字符串拼接即可 | 依赖模型/API 是否暴露 token 级 embedding |
| 本仓 | **可做、推荐** | **不做**（除非以后模型与 SDK 明确支持） |

窗口 enrich **不是** late chunking；只是让切片边界别「太瞎」。

### 1.6 实现落点（P1）

| 步骤 | |
|------|--|
| 切分时保留每个 piece 在全文（或节内）的 `start/end` 或 `left/right` 邻域字符串 | `headingRecursive` 扩展 |
| `buildEmbedInput({ title, path, heading_path, left, core, right })` | 新模块 |
| `embed(buildEmbedInput(...))`，`text=core` | `indexService` |
| 单测：邻域与 meta 进 embed 入参；`text` 无邻域 | |

---

## 2. 父子块：逐步算法 + 完整例子

### 2.1 人话版（先看这个）

把一篇长笔记想成一本书：

1. **先按大标题拆成「章」**（我们叫「节」）。  
2. 某一章如果不长 → 整章就是一块，既能搜也能读。  
3. 某一章太长 →  
   - 书架上放一张 **整章复印件**（父块）：给人读，**不做**向量检索；  
   - 再把这章撕成几张 **小纸条**（子块）：每张纸条单独做向量，**用来搜**。  
4. 用户提问时：只在小纸条里找最像的。  
5. 找到某张小纸条后：把对应的 **整章复印件** 拿给用户/Agent 看。

这样：**搜的时候准（小），读的时候全（大）**。  
短章不折腾父子，省事。

### 2.2 目标（一句话）

**父 = 一节的完整正文（可读、默认可不 embed）；子 = 节内过长切开后的片（可 embed、可检索）。搜子，读父。**

### 2.3 输入例子

笔记 `doc_id=D1`，`title=缓存笔记`，`path=lab/cache.md`：

```markdown
# 简介

缓存能降低延迟。

# 策略

先写本地缓存。本地缓存命中则直接返回。
若未命中则读数据库，再回填缓存。
回填时要注意过期时间与并发。

（……假设「策略」整节很长，超过 max_tokens……）

# 小结

记得监控命中率。
```

配置示意：`max_tokens` 较小，使得「策略」节必须切开；「简介」「小结」一节一块。

### 2.4 步骤 1：去 frontmatter，得到 Body

（本例无 frontmatter，Body = 全文。）

### 2.5 步骤 2：按标题切「节」（父的原料）

| secIndex | heading_path | 节正文（parent 候选 text） |
|----------|--------------|---------------------------|
| 0 | `(intro)` | （本例标题前无字，可无此节） |
| 1 | `简介` | `缓存能降低延迟。` |
| 2 | `策略` | `先写本地缓存。…过期时间与并发。`（很长） |
| 3 | `小结` | `记得监控命中率。` |

这是 **逻辑节**，还不是 Lance 行。

### 2.6 步骤 3：对每一节决定 leaf 还是 parent+children

**规则：**

```text
if tokens(节正文) <= max_tokens:
    只写 1 行 leaf
else:
    写 1 行 parent（整节正文，vector 空）
    对节正文 recursiveSplit → 多个 child（各有 vector）
```

#### 节「简介」（短）

```text
→ 1 行 leaf
  chunk_id:        D1#0
  chunk_role:      leaf
  parent_chunk_id: (空)
  heading_path:    简介
  text:            缓存能降低延迟。
  vector:          embed(enrich(…, core=该 text, ±N 在 Body 中邻域))
```

#### 节「策略」（长）→ 假设切成 2 片

```text
→ parent 行
  chunk_id:        D1#p#2          # 或 D1#p#<hash(策略)>
  chunk_role:      parent
  parent_chunk_id: (空)
  heading_path:    策略
  text:            【整节全文】先写本地缓存。…并发。
  vector:          (不写 / 空)     # v1 不 embed 父，省资源

→ child 行 0
  chunk_id:        D1#c#2#0
  chunk_role:      child
  parent_chunk_id: D1#p#2
  heading_path:    策略
  text:            先写本地缓存。本地缓存命中则直接返回。
  vector:          embed(enrich(…, core=child0, left/right=在 Body 中 ±N))

→ child 行 1
  chunk_id:        D1#c#2#1
  chunk_role:      child
  parent_chunk_id: D1#p#2
  heading_path:    策略
  text:            若未命中则读数据库，…并发。
  vector:          embed(enrich(…))
```

#### 节「小结」（短）

```text
→ 1 行 leaf（同简介）
```

### 2.7 步骤 4：写入 Lance

`deleteByDocId(D1)` 后 `insert` 所有 leaf + parent + child。  
**ANN / 向量检索只扫有 vector 的行**（leaf + child）。

### 2.8 步骤 5：检索时发生什么

用户 query：「缓存未命中怎么办」

```text
1. embed(query)（query 侧是否 enrich 另议；v1 可不做）
2. 在 leaf+child 的 vector 上 ANN
3. 命中 child D1#c#2#1（score 最高）
4. expand=parent（默认）：
     取出 parent_chunk_id → D1#p#2
     把 parent.text（整节「策略」）作为 expanded_text / 给 Agent 的上下文
5. snippet 可用 child.text 或 parent 截断；调试可同时返回两者
6. aggregate=true 时仍按 doc_id 折叠，代表分用该 child 的 score，正文优先 expanded
```

```text
用户感知：
  搜得很准（小块向量）
  读到的是整节「策略」，不会只看到半句
```

### 2.9 步骤总览（一张图）

```text
MD
 │
 ├─(1) 按 # 切节 ─────────────────────────────┐
 │                                            │
 │   简介(短)  策略(长)  小结(短)                │
 │      │         │         │                 │
 │      │         ├─ recursive 切成片          │
 │      │         │    片0, 片1, …             │
 │      ▼         ▼         ▼                 │
 │   leaf      parent     leaf                │
 │            + children                      │
 │      │         │         │                 │
 │      └─(2) enrich 窗口后 embed ─────────────┤ 仅 leaf/child
 │               (parent 不 embed)             │
 │                                            │
 └─(3) 写入 text_chunks ◄─────────────────────┘

Search: ANN(leaf|child) → 命中 child → 读 parent.text
```

### 2.10 与 Enrich 如何叠

| 行 | embed 吗 | embed 输入 |
|----|----------|------------|
| leaf | 是 | meta + (±N 窗口，中心=leaf.text) |
| child | 是 | meta + (±N 窗口，中心=child.text) |
| parent | **否** | — |

### 2.11 配置草案

```yaml
chunk:
  strategy: heading_recursive
  max_tokens: 512
  overlap_tokens: 64
  enrich: true
  enrich_neighbor_chars: 256
  enrich_meta: true
  parent_child: false       # P2 打开
  search_expand: parent     # none | parent
```

### 2.12 分期

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 本文（纠正 enrich + 父子逐步例） | ✅ |
| P1 | 窗口 Enrich（±N + 可选 meta） | ✅ 代码 + 单测 |
| P2 | 父子行 + search expand | ⬜ |

---

## 3. 协作

- **Enrich 语义以第 1 节为准**（邻域窗口，不是整篇原文进每个向量）。  
- **父子算法以第 2 节逐步例为准**。  
- 改语义先改本文再写代码（BACKLOG C-15 / C-16）。
