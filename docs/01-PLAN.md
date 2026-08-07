# yk-vector-ts — 实现计划

| 项 | 内容 |
|----|------|
| **状态** | T0–T5 本服务主路径已落地 |
| **更新** | 2026-08-04 |
| **全量任务** | [03-BACKLOG.md](03-BACKLOG.md) |

---

## 0. 目标

独立进程 **yk-vector-ts**：切分 + 向量检索 + 接 lensd hybrid；Lance 用 **官方 TS SDK**。

---

## 1. 分期

| 阶段 | 交付 | BACKLOG | 本服务 |
|------|------|---------|--------|
| T0 | 骨架 + health + Open Lance | B0 | ✅ |
| T1 | replace/delete/search + 切分 + 精确路径 | B1 | ✅ |
| T2 | 接 lensd | B2 | ∅ lensd 已有；切默认 🟨 |
| T3 | Import 验收 | B3 | 🟨 待对 ts 重跑 |
| T4 | 时间窗 | B4 | ✅ 服务侧 |
| T5 | 文档聚合 | B5 | ✅ |
| C-* | remove_and_insert/async/ANN/多模态/rename | C-4/5/6/9/10 | ✅ |

---

## 2. 技术选型（锁定）

| 项 | 选择 |
|----|------|
| 语言 | TypeScript (Node ≥ 20) |
| 存储 | Lance 本地 + `@lancedb/lancedb` |
| ANN | **IVF_FLAT + cosine**（见 06） |
| 切分 | heading_recursive |
| Embed | Qwen3 + 可选 VL |

---

## 3. 下一动作（删 go 前）

1. `LENS_VECTOR=http://localhost:8703` 联调 hybrid  
2. 按 [10](10-T3-ACCEPTANCE.md) 跑 Import/temp  
3. Dev 代理改 8703（可选）  
4. 确认无依赖 go 后归档/删除 `yk-vector-go`  
