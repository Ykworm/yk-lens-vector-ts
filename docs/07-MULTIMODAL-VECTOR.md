# 多模态向量：含 Image 的 MD（权威流程）

| 项 | 内容 |
|----|------|
| **状态** | 设计规格（2026-08-04 对齐；可评审） |
| **用途** | 人评审逻辑 + **写代码时按步骤实现**，不要临场发明 |
| **实现对照** | [12-C9-MULTIMODAL.md](12-C9-MULTIMODAL.md) |
| **相关** | 切分细节 [02-DESIGN-DETAIL.md](02-DESIGN-DETAIL.md)；ID [根词典](../../docs/00-SHARED-IDS.md) |

---

## 0. 范围

| 在范围 | 不在范围 |
|--------|----------|
| **MD 派生入库**：调用方提交整篇 MD（典型 `POST /v1/index/replace`），服务从 MD 里处理正文 + 图 | 显式 `upsert_text` / `upsert_image`（另节；简单测试用） |
| 同一 `doc_id` 下 text 行 + image 行 | 视频；hybrid 默认文搜图 |
| 图行：**仅图像向量**（文字向量后置） | 产品语义上的「第几张」 |

**一句话**：一篇 MD → 先删该 `doc_id` 旧数据 → 正文切块文本 embed → 图取字节图像 embed → 写入两类行；图尽力而为，结果写进返回。

---

## 1. 谁调用、入参长什么样

### 1.1 调用方

| 调用方 | 职责 |
|--------|------|
| **lensd**（主路径） | 读 vault MD；带上 `doc_id` / `path` / `content_hash` / `content` 调 replace |
| 实验台 / 测试 | 可直接调；图测试长期应走 `upsert_image`，但 replace + MD 仍须语义正确 |

**本服务不持 vault、不读磁盘路径上的相对图文件**（见第 5 节）。

### 1.2 replace 入参（MD 派生必备）

| 字段 | 必填 | 含义 |
|------|------|------|
| `doc_id` | 是 | 笔记稳定 ID（lensd 生成；本服务不发号） |
| `content` | 是 | **整篇 MD 字符串**（含 frontmatter 与否由上游约定；切分侧会去 frontmatter） |
| `path` | 建议 | vault 相对路径，冗余进每一行，便于展示/打开 |
| `content_hash` | 建议 | 笔记指纹；未变且未 `remove_and_insert` → 整篇 skip |
| `project` / `title` | 可选 | 过滤与展示 |
| `created_at` / `updated_at` | 可选 | 时间过滤 |
| `remove_and_insert` | 可选 | true = 忽略 hash skip，强制重建 |
| `async` | 可选 | true = 入队（语义仍是同一套管线） |

**没有**入参字段：`modality`、`image_index`、「第几张」。类型由 MD 内容派生。

---

## 2. 总流程（实现必须按此顺序）

```
输入：ReplaceRequest（含 content = 整篇 MD）

A. 校验
   - doc_id、content 非空
   - 文本 embedding 已配置；否则整次失败（无法建 text 行）

B. skip 判断
   - 若 !remove_and_insert 且 content_hash 非空且与库中该 doc_id 记录相同
   - → 返回 ok + skipped，不删不建
   - （注意：换 VL 模型、修图逻辑时应用 remove_and_insert 或改 hash 策略——见第 9 节待决）

C. 删除
   - 按 doc_id 删除 text_chunks + image_chunks 中该文档全部旧行
   - 不允许「只删文不删图」或反过来

D. 正文管线 → 得到 text 行列表（见第 3 节）
   - 任一块文本 embed 失败 → 整次失败（已删旧数据：见第 8 节）

E. 附图管线 → 得到 image 行列表 + 图结果摘要（见第 4～6 节）
   - 单图失败 → 跳过该图，继续；不导致整次失败
   - VL 未配置但 MD 含图 → 全部图跳过，写入返回说明

F. 写入
   - 将 text 行 + 成功的 image 行一并 insert
   - 若 text 与 image 都为空（极端：空 MD 且无图）→ ok，chunks=0

G. 返回（见第 7 节）
   - ok=true（在 D 成功的前提下）
   - 必须带正文数量 + 图找到/成功/失败信息
```

**更新语义只有一种：先删后建。** 不做 per-chunk、per-image 增量。

---

## 3. 正文管线（text 行）

| 步 | 行为 | 产出 |
|----|------|------|
| 3.1 | 对 `content` 做 **heading_recursive** 切分（规则见 02） | 若干 `{ text, chunkIndex, headingPath }` |
| 3.2 | 对每块调用 **文本 embedding** | `vector` |
| 3.3 | 组装 text 行 | 写入 `text_chunks` |

### 3.1 text 行字段（逻辑列）

| 字段 | 来源 | 说明 |
|------|------|------|
| `chunk_id` | `doc_id + "#" + chunk_index` | 篇内块 ID；删建后可重排 |
| `doc_id` | 入参 | |
| `path` | 入参 | 文件路径冗余 |
| `content_hash` | 入参 | 本次索引时笔记指纹 |
| `project` / `title` | 入参 | |
| `text` | 切分结果 | 块正文 |
| `vector` | 文本模型 | **仅此类行** |
| `modality` | 固定 `text` | |
| `chunk_index` | 切分序号 | 从 0 |
| `heading_path` | 切分 | 章节路径 |
| `created_at` / `updated_at` | 入参 | |
| `indexed_at` | 本服务当前时间 | |

**禁止**：text 行写 `image_vector`。

---

## 4. 附图发现（从 MD 解析）

### 4.1 识别规则

从 `content` 中抽取图引用（实现可迭代，**规格最低集**）：

| 语法 | 处理 |
|------|------|
| `![alt](uri)` | 抽取；`alt` 可空 |
| `<img ... src="uri" ...>` | 抽取；alt 可另解析或空 |

| 规则 | 说明 |
|------|------|
| 上限 | `vl.max_images`（默认 32）；超出部分 **不处理**，并在返回中说明「超出上限未处理」 |
| 去重 | **同一 `uri` 字符串在本篇只处理一次**（先出现优先）；避免 data URL 重复 embed |
| 0 张 | 正常；跳过附图管线，返回 `images_found=0` |
| 不做 | 「第几张」业务字段；用户可见文案不要写「第 N 张」 |

### 4.2 每张图在解析阶段应有的信息

| 信息 | 必填？ | 说明 |
|------|--------|------|
| `uri` | 是 | MD 里的原始引用 |
| `alt` | 否 | 展示用短文案；可进 image 行的 `text` 字段（**不是**文本向量） |
| 文件 `path` | 是（用入参） | 与笔记同一 path |
| 结构位置 `heading_path` | **建议有** | 图出现位置对应的章节路径（与邻近正文一致）；便于展示。实现若暂空，属债务，规格要求尽量填 |
| 关联 text chunk | 后置可选 | 现在不做「挂文字向量」；不必强绑 chunk_id |

### 4.3 行主键（不做「第几张」）

| 规则 | 说明 |
|------|------|
| 对外 | 不暴露、不宣传 `image_index` / 「第几张」 |
| 对内 | 每行必须有全局唯一 `chunk_id`（或表主键） |
| 算法（已实现） | `chunk_id = doc_id + "#img#" + sha256(uri_or_key)[:16]`（`makeImageChunkIdFromKey`） |
| 禁止 | 把「抽取顺序 0,1,2…」写成产品 API 字段或稳定 ID |

---

## 5. 三种 URI：如何变成可 embed 的图

| 类型 | 判定 | 谁取字节 | 失败时 |
|------|------|----------|--------|
| **data URL** | `uri` 以 `data:image/` 开头 | **本服务**解码 base64 | 跳过该图 + 记入返回 |
| **http(s)** | `http://` / `https://` | **本服务** HTTP GET（超时、大小上限） | 跳过该图 + 记入返回 |
| **相对 / vault 路径** | 其余（如 `./x.png`、`inbox/files/a.png`） | **本服务默认不能读 vault** | **跳过该图** + 返回明确原因：`relative_path_needs_upstream`（或等价文案） |

### 5.1 上游（lensd）约定

| 约定 | 说明 |
|------|------|
| 希望本服务索引 vault 内图 | lensd 在调 replace **之前**把相对路径换成 data URL 或可访问的 http(s)，或以后走 `upsert_image` 传字节 |
| 本服务 | 相对路径 **不静默当成功**；必须出现在「图未入库原因」里 |

### 5.2 资源限制（实现应有默认）

| 限制 | 建议默认 | 超限 |
|------|----------|------|
| 单图下载/解码大小 | 如 8 MiB | 跳过该图 + 原因 |
| http 超时 | 如 30s | 跳过该图 + 原因 |
| 单篇最多图 | `max_images` | 多余不处理 + 原因 |

---

## 6. 附图写入（image 行）

仅当 VL/图像 embedding **已配置** 时进入 embed；未配置见第 6.3 节。

| 步 | 行为 |
|----|------|
| 6.1 | 对第 5 节得到的字节（或 data URL）调用 **VL embed 图像** |
| 6.2 | 得到 `image_vector`；空向量视为失败 → 跳过该图 |
| 6.3 | 组装 image 行 → 与 text 行一并 insert |

### 6.1 image 行字段（逻辑列）

| 字段 | 来源 | 说明 |
|------|------|------|
| `chunk_id` | 第 4.3 节算法 | 唯一主键 |
| `doc_id` | 入参 | |
| `path` | 入参 | 笔记 path，不是图文件 path（除非上游另传） |
| `content_hash` | 入参 | 同笔记指纹 |
| `project` / `title` | 入参 | |
| `text` | `alt` 等短文案 | **仅展示/snippet**；现在 **不做** 文本 embedding |
| `image_vector` | VL | **仅此类行** |
| `modality` | 固定 `image` | |
| `image_uri` | 原始 uri 或安全截断策略 | data URL 极长：存储策略实现自定（可存 hash + 预览标记）；Browse 勿整段喷 JSON |
| `heading_path` | 解析阶段 | 建议填章节路径 |
| 时间字段 | 同 text 行 | |

**禁止**：image 行写文本模型的 `vector` 列；**禁止**用文本模型 embed 图。

### 6.2 成功张数

- MD 中识别 N 张（去重、截断后）→ `images_found = N`  
- 实际写入 M 行 → `image_chunks = M`（M ≤ N）  
- N−M 的原因全部进入返回列表  

### 6.3 VL 未配置

| 情况 | 行为 |
|------|------|
| MD 无图 | 正常只建 text |
| MD 有图 | text 照常；**所有图不入库**；返回中说明 `vl_not_configured`；**整体仍 ok** |

---

## 7. 返回契约（MD 派生 replace）

在 **正文管线成功** 的前提下：

| 字段 | 含义 |
|------|------|
| `ok` | `true` |
| `doc_id` | |
| `skipped` | hash skip 时 true |
| `text_chunks` | 写入的 text 行数 |
| `images_found` | 解析到的图引用数（去重/截断后） |
| `image_chunks` | 成功写入的 image 行数 |
| `image_errors` | 字符串列表：每条对应一张未入库图的原因（可读） |
| `chunks` | 可选：`text_chunks + image_chunks` 总数（兼容旧字段） |
| `status` | 如 `done` / `queued` |

### 7.1 原则

| 原则 | |
|------|--|
| 文本成功 ⇒ 整体成功 | 即使全部图失败 |
| 图尽力而为 | 单图失败不翻盘 |
| **用户可感知** | `image_errors` / 数量字段必须进 HTTP body；禁止只打日志 |
| UI | 实验台 / 调用方应展示「MD 含图：找到 N，成功 M，失败 …」 |

### 7.2 正文失败

| 情况 | 行为 |
|------|------|
| 文本 embedding 未配置 / 某 text chunk embed 失败 | **整次失败**（非 ok）；此时若已执行删除，库中该 doc 可能暂时无行——实现须在错误信息中诚实说明，或改为「先 embed 再删再写」事务策略（见第 9 节） |

---

## 8. 检索（入库之后怎么搜）

与入库对称，**mode 显式**：

| mode | 用户输入 | 编码 | 搜哪类行 |
|------|----------|------|----------|
| `text` | 字 | 文本 embedding | text / `vector` |
| `text_to_image` | 字 | **VL 编文本** | image / `image_vector` |
| `image_to_image` | 图 | VL 编图 | image / `image_vector` |

- 文搜图 **不依赖** 图行上的文字向量（文字向量后置）。  
- 命中 image 行时：`modality=image`；snippet 可用 alt；不要指望 OCR 全文在 snippet 里。

---

## 9. 待你拍板 / 已知大问题（评审用）

下面几条 **规格未锁死** 或 **实现有坑**，写代码前建议你点头或改：

| # | 问题 | 现状/选项 | 影响 |
|---|------|-----------|------|
| Q1 | **先删后 embed**：text embed 中途失败时，旧数据已删 | 现状：先删再 embed；可选改为「全部 embed 成功再删再写」 | 失败时该 doc 短暂或持续搜不到 |
| Q2 | **hash skip 与换 VL 模型** | hash 只反映 MD 文本；换模型/修 VL 不会自动重嵌图 | 运维需 `remove_and_insert` 或 reindex |
| Q3 | **图 `heading_path`** | 规格建议填；现状实现常为空 | 展示与「图在哪一节」 |
| Q4 | **image 行主键** | 规格推荐 `doc_id#img#hash(uri)`；现状可能是序号 | 对齐「不做第几张」 |
| Q5 | **data URL 是否落库原文字符串** | 极长；Browse/日志爆炸 | 建议存截断或 fingerprint |
| Q6 | **相对路径** | 本服务跳过 + 报错原因；是否强制 lensd 必须先展开 | 生产笔记插图能否进库 |
| Q7 | **代码块里的 `![]()`** | 是否抽取 | 误抽示例图 vs 漏真图 |
| Q8 | **显式 upsert** 失败是否也 200 | **已定**：upsert 失败直接 error（4xx/5xx）；MD 派生路径仍可整体 ok | 测试语义干净 |

**不在争议**：整篇删建、双空间不混用、不做第几张产品字段、图行暂不挂文字向量、MD 含图时图失败写进返回且整体 ok。

---

## 10. 与显式 upsert 的边界（避免混谈）

| | MD 派生 `replace` | `upsert_image` / `upsert_text` |
|--|-------------------|--------------------------------|
| 输入 | 整篇 MD | 调用方直接给文本或图字节 |
| 类型 | 服务从 MD 推断 | 调用方已选 API |
| 失败 | 图失败可跳过，整体仍可 ok | **该请求直接失败**（4xx/5xx） |
| 用途 | 笔记真源同步 | 简单测试、工具 |

```http
POST /v1/index/upsert_text
{ "doc_id", "text", "path?", "project?", "title?", "chunk_index?" }

POST /v1/index/upsert_image
{ "doc_id", "image_data_url" | "image_base64"+"image_mime"?, "alt?", "path?", "project?", "title?" }
```

同 `chunk_id` 先删后插。实验台 **Upsert** 页直连；测图优先走 `upsert_image`，不要只靠假 MD 塞 data URL。

---

## 11. 实现检查清单（写代码 / Code Review）

- [ ] 顺序：校验 → skip → **删 doc 全文图** → text → images → insert → 返回  
- [ ] text embed 失败不静默  
- [ ] 单图失败不拖垮整次；原因进 `image_errors`  
- [ ] 相对路径有明确错误原因，不装成功  
- [ ] VL 未配置 + MD 有图：有返回说明  
- [ ] 无对外「第几张」；主键不宣传序号  
- [ ] 无图行文字向量  
- [ ] search 三 mode 空间不混用  
- [ ] 响应含 `text_chunks` / `images_found` / `image_chunks` / `image_errors`  

---

## 12. 文档关系

| 文档 | 角色 |
|------|------|
| **本文** | MD 含图 **完整流程规格**（权威） |
| [12-C9](12-C9-MULTIMODAL.md) | 代码落点与债务 |
| [00-FEATURE](00-FEATURE.md) | HTTP 总表 |
| [02](02-DESIGN-DETAIL.md) | 切分与 replace 骨架 |
