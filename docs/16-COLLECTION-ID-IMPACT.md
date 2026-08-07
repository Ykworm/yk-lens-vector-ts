# collection_id（书 / 合集）改动面清单

| 项 | 内容 |
|----|------|
| **状态** | 设计 + 改动面（2026-08-04）；**需求定案**（2026-08-06）；**19-A…F 已实现**（2026-08-06，见 `yk-lens-go/docs/01-PLAN.md` Step 19 / `04-PROGRESS.md`） |
| **目的** | 多篇 MD（不同 `doc_id`）归属同一本书/合集；检索可按书过滤；与 `theme` / `project` 区分 |
| **相关** | 词典 [00-SHARED-IDS](../../docs/00-SHARED-IDS.md) · Enrich/切分 [15](15-PARENT-CHILD-AND-ENRICH.md) · 计划 [01-PLAN Step 19](../../../yk-lens-go/docs/01-PLAN.md) |

---

## 0.5 决策冻结（2026-08-06 用户拍板）

| 项 | 决策 |
|----|------|
| 主键 | `collection_id` = lensd 雪花（与 `doc_id` 同族 idgen）；**name / slug / 文件夹名绝不充当主键** |
| 元数据 | `collection_title` / `collection_ord` **每篇 frontmatter 全冗余写**；随手打开一篇即见全部信息；接受漂移，改名 = 批量刷 replace |
| 文件夹约定 | 合集目录名 = `<可读slug>-<4位随机>`（如 `yc-fall-2026-8f3k`，随机串 `[a-z0-9]`）；仅路径唯一性 / 人可读，**不当主键** |
| 场景 | ① 导入 wiki 文件夹 → 自动建合集（目录名 → name）并批量写入；② 手动归集：多篇归入新 / 已有合集，可跨目录，不强制建文件夹 |
| 边界 | **project ⊃ collection，不跨 project**；v1 单值（一篇只属一个合集）；检索单元仍是 chunk，打开真源仍用 `doc_id` |
| 命名 | 统一「合集 / collection」，**不叫 book** |
| 删除 | 删单篇不影响同合集其它篇；删合集 = 显式按 collection_id 列 doc 再逐个删（admin，后置） |
| 顺序 | **单线串行**；不掺 C-16 父子块（其保持 ⬜ 未做） |

---

## 0. 概念（先钉死）

| 名字 | 是什么 | 不是什么 |
|------|--------|----------|
| **`doc_id`** | **一篇** L1 Markdown 的稳定 ID | 不是书 |
| **`collection_id`** | **一本书 / 一个合集** 的稳定雪花 ID；其下多篇 `doc_id` 共用 | 不是 theme（一书可多主题） |
| **`project`** | vault 一级分区（inbox 等） | 太粗，一 project 多书 |
| **`theme_id`** | 主题/标签，多对多 | 不能 1:1 当书 |
| **`path`** | 磁盘相对路径 | 可约定 `books/foo/ch01.md` 作弱提示，**不当主键** |

```text
collection_id = B（「某书」）
  ├── doc_id = md002  ch01.md
  └── doc_id = md435  ch12.md
```

检索单元仍是 chunk；归属书用 `collection_id`；打开真源仍用 `doc_id`。

---

## 1. 建议字段（全链路一致）

| 字段 | 类型 | 谁生成 | 存在哪 |
|------|------|--------|--------|
| **`collection_id`** | 雪花十进制字符串 | lensd（与 doc_id 同族 idgen） | frontmatter · Meili · Lance 行 · API · 可选 Graph |
| **`collection_title`** | 可选字符串 | 人/导入 | frontmatter 冗余；Lance/Meili 可选 |
| **`collection_ord`** | 可选 int/string | 人/导入 | 章序；frontmatter；列表排序 |

frontmatter 示例：

```yaml
---
doc_id: "3429..."
collection_id: "3500..."
collection_title: "YC Fall 2026 笔记"
collection_ord: 12
title: 第12章
project: inbox
---
```

无 `collection_id` = **独立笔记**（合法）；不强制一书。

---

## 2. 改动面总表

| 层 | 改什么 | 优先级 |
|----|--------|--------|
| **词典** | `00-SHARED-IDS` 增加 collection_* | P0 文档 ✅ 本文件 + 词典补丁 |
| **真源 MD** | frontmatter 读写 | P1 |
| **lensd store.Doc** | 结构体 + 扫库/写盘 | P1 |
| **lensd API** | 列表/详情/搜索过滤/创建合集 | P1～P2 |
| **Meili** | filterable `collection_id` | P1 |
| **vectorclient → yk-vector-ts** | replace/search body 透传 | P1 |
| **yk-vector-ts** | 行模型、filter、Browse | P1 |
| **app 前端** | 合集 UI、过滤、实验台 | P2（产品）/ 实验台可先手填 |
| **Graph / wiki** | 可选：Collection 节点 | P3 |
| **MCP** | 若暴露检索/写笔记 | P2 |

---

## 3. 分仓明细

### 3.1 文档 / 词典

| 文件 | 动作 |
|------|------|
| `docs/00-SHARED-IDS.md` | 正式词条 `collection_id` 等 |
| `yk-vector-ts/docs/16-…`（本文） | 改动面与分期 |
| `yk-lens-go/docs/*` | API/Plan 引用 collection 过滤 |
| `yk-vector-ts/docs/00-FEATURE.md` | 行字段、search filter |

### 3.2 yk-lens-go（lensd）

| 区域 | 改动 |
|------|------|
| `internal/store/store.go` `Doc` | 增加 `CollectionID` / 可选 Title、Ord；JSON `collection_id` |
| frontmatter 解析/写回 | 读 `collection_id`；缺则空；**不**用 path 自动猜 ID（可工具建议） |
| 扫库 `Load` | 带上字段 |
| `WriteVault` / 更新笔记 | 允许写入/保留 collection_* |
| `internal/vectorclient` `ReplaceReq` | 增加 `collection_id`（及可选 title/ord）随 replace 下发 |
| Meili `meiliDoc` | 字段 + **filterable** `collection_id` |
| `KeywordFilter` / Search | 支持 `collection_id` 过滤 |
| hybrid / Search API | query 带 `collection_id` 时 Meili + 向量两侧下推 |
| 新 API（建议） | `GET/POST /v1/collections` 列表/创建合集元数据（元数据可先只活在 frontmatter 聚合） |
| admin reindex | replace 带上 collection |
| 测试 | store / meili / vectorclient / memory |

**不改：** `doc_id` 发号规则；delete 仍按 doc_id（删一篇≠删整本书）。

**删书：** 需显式「按 collection_id 列出 doc 再逐个 delete」或新 admin 接口（后置）。

### 3.3 yk-vector-ts

| 区域 | 改动 |
|------|------|
| `types.ChunkRow` / `SearchHit` | `collection_id?`、可选 `collection_title`、`collection_ord` |
| `toTextRecord` / `toImageRecord` | 写入列 |
| `ReplaceRequest` / `Upsert*` | 入参 `collection_id?` |
| `replaceSync` / upsert | 行上抄 collection 字段 |
| `SearchRequest` + `buildWhere` | `collection_id = '…'` 过滤（text + image 表） |
| `SearchFilter` / admin rows | 可选按 collection 扫 |
| Lance 已有表 | **已实现**：open / insert 前 `addColumns` 补 `collection_id` / `collection_title` / `collection_ord`（旧行 `''` / `0`）；避免 `Found field not in schema` |
| health / 文档 | FEATURE 契约 |
| 测试 | filter + replace 透传 |

**仍不：** 持 vault；collection 元数据权威仍在 lensd/MD。

### 3.4 app 前端

| 区域 | 改动 |
|------|------|
| 类型 `Doc` / API | `collection_id` |
| 笔记详情 / frontmatter 编辑 | 展示与编辑合集 |
| 检索 UI | 过滤器「当前合集」 |
| 列表 | 按 collection 分组（产品页） |
| **实验台 Lance** | replace/upsert 表单项手填 `collection_id`；Browse 列；Search 过滤 | 可先做实验台 |
| vault 文件树 | 若 path 约定 `books/<slug>/` 仅展示，ID 仍 frontmatter |

### 3.5 其它

| 区域 | 改动 |
|------|------|
| MCP lens-mcp | 写笔记/搜若暴露 project，对称加 collection |
| coverto 导入 | 批量导入一书时写入同一 `collection_id` |
| Graph | 可选 Collection 节点 → 多 Doc；**不**替代 collection_id 字段 |
| 备份/导出 | 导出 frontmatter 含 collection |

---

## 4. 数据流（有 collection 时）

```text
人/导入 写 frontmatter.collection_id
    → lensd 读盘 → Doc.CollectionID
    → Meili index（可 filter）
    → vector Replace{ doc_id, collection_id, content, … }
    → Lance 每行带 collection_id

Search(collection_id=B):
    Meili filter collection_id=B
    vector search where collection_id=B
    → 仍返回 doc_id + chunk；打开笔记用 doc_id
```

---

## 5. 分期建议

| 阶段 | 内容 | 仓库 |
|------|------|------|
| **D0** | 词典 + 本文 + FEATURE 引用 | docs ✅ |
| **D1** | vector-ts 行字段 + search filter + 实验台手填 | yk-vector-ts + app/dev |
| **D2** | lensd Doc + frontmatter + Meili + vectorclient 透传 | yk-lens-go |
| **D3** | 产品 UI 合集过滤/分组 | app |
| **D4** | 合集 CRUD API、导入批量、Graph | 后置 |

**可与 Enrich（15 P1）并行：** Enrich 只动 embed 输入；collection 是归属字段，冲突小。  
建议：**Enrich 先或与 D1 同旬；D2 与产品强绑定再上。**

> **2026-08-06 更新**：需求定案后改为**单线串行**，分期并入 `yk-lens-go/docs/01-PLAN.md` **Step 19（19-A…19-F）**；不再并行 C-16（保持未做）。

---

## 6. 验收（collection）

- [ ] 两篇不同 doc_id、同一 collection_id，replace 后 Lance/Meili 可滤出仅该书  
- [ ] 无 collection_id 的笔记行为与现在一致  
- [ ] 改 collection_id 后 reindex/replace 更新行字段  
- [ ] 删除单 doc 不影响同书其它 doc  
- [ ] 实验台能手填并过滤 collection_id  

---

## 7. 非目标

| 不做 | |
|------|--|
| 用 theme 冒充书 | |
| 自动 path 推断 collection_id 当唯一真相 | 最多「建议」 |
| 一篇 doc 属于多个 collection（v1） | v1 单值；多集后置 |
| vector 发 collection_id | 只接收 lensd/调用方 |

---

## 8. 一句话

**书 = `collection_id`；篇 = `doc_id`；块 = chunk。**  
改动穿透 **MD → lensd → Meili → vector-ts → 前端**；实验台可先手填验证向量过滤，产品 UI 后做。
