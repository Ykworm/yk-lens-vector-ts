# yk-lens-vector-ts — 目录结构 · Agent 接入（已锁定）

| 项 | 内容 |
|----|------|
| **状态** | 已定 |
| **对应** | 原 go 文档 08-GO-LAYOUT-AND-MCP |

---

## 1. 进程边界

- 独立 Node 进程，默认 **`:8703`**
- **仅** lensd HTTP 调用；无独立 vector MCP
- Agent：`lens-mcp → lensd`（可扩展 tool，不直连本服务）

---

## 2. 目录树

```text
yk-lens-vector-ts/
├── package.json
├── tsconfig.json
├── configs/
│   └── yk-lens-vector-ts.example.yaml
├── scripts/dev.sh
├── docs/                    # 本目录：权威文档
├── src/
│   ├── index.ts             # 入口
│   ├── config.ts
│   ├── types.ts
│   ├── api/server.ts        # HTTP
│   ├── chunk/headingRecursive.ts
│   ├── embed/client.ts      # 文本
│   ├── embed/vl.ts          # 跨模态
│   ├── image/extract.ts
│   ├── store/lanceStore.ts  # Lance 官方 SDK
│   ├── store/aggregate.ts
│   ├── service/indexService.ts
│   └── service/jobs.ts
└── data/                    # gitignore；lance_path 默认落点
```

依赖方向：`index → api → service → {chunk, embed, image, store}`。

---

## 3. 配置与环境变量

| 变量 | 含义 |
|------|------|
| `YK_VECTOR_ADDR` | 默认 `:8703` |
| `YK_VECTOR_LANCE` | Lance 目录 |
| `YK_VECTOR_INDEX` | `ivf_flat` \| `none` |
| `YK_VECTOR_EMBED_*` | 文本 embedding |
| `YK_VECTOR_VL_*` | 跨模态 |
| `YK_VECTOR_REPLACE_ASYNC` | 默认异步 |

lensd：`LENS_VECTOR=http://localhost:8703`。

---

## 4. Agent / MCP

| 规则 | 说明 |
|------|------|
| 无 yk-vector-mcp | 不另起进程 |
| 向量类 tool | 若需要，挂 **lens-mcp**，经 lensd |
| 生产禁止 | Agent 直连 :8703 |
