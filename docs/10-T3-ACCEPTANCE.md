# T3 验收：Import / temp / Direct write

| 项 | 内容 |
|----|------|
| **BACKLOG** | B3-A / B3-B / B3-C |
| **依赖** | lensd + `LENS_VECTOR=http://localhost:8703`（yk-vector-ts） |
| **闸门代码** | `yk-lens-go`：`ShouldIndexDoc` + `vectorReplace` 双重 L1 |
| **单测** | `yk-lens-go/internal/memory/t3_paths_test.go`（fake 向量，不依赖真 embedding） |

---

## 0. 一句话

**只有进 vault 的 L1 才会 replace；coverto temp 永不进向量；Direct write 与 Import 落地都会触发向量。**

---

## 1. 路径对照

| 入口 | L1？ | 向量 replace？ |
|------|------|----------------|
| Direct write `POST /v1/vault` → notes/ | ✅ | ✅ |
| Import / vault commit → imports/ | ✅ | ✅ |
| coverto 沙箱 temp（vault 外） | ❌ | ❌ |
| files/ · chats/ | ❌ | ❌ |

---

## 2. 验收勾选

### 单测（CI / 本地，无需 embedding key）

```bash
cd yk-lens-go
go test ./internal/memory/ -run 'TestT3_' -v
```

| ID | 单测 | 状态 |
|----|------|------|
| B3-A | `TestT3_B3A_ImportPathIndexesVector` | 以跑测为准 |
| B3-B | `TestT3_B3B_TempAndNonL1NeverVector` | 以跑测为准 |
| B3-C | `TestT3_B3C_DirectWriteIndexesVector` | 以跑测为准 |

### 手工 E2E（需真实 embedding key + 起服务）

缺一不可：

1. `YK_VECTOR_EMBED_API_KEY`（及可用 base_url/model）
2. `yk-vector-ts` 在 `:8703`（`dev.sh start` 或 `npm run dev`）
3. `lensd` 在 `:8700` 且 `-vector http://localhost:8703`

```bash
# B3-C Direct write
curl -s -X POST localhost:8700/v1/vault -H 'Content-Type: application/json' -d '{
  "content": "T3 direct 独特短语 hybrid 探针 xyz-t3-ts",
  "title": "t3-direct",
  "project": "inbox"
}'
curl -s localhost:8703/healthz   # chunks 应增加
curl -s -X POST localhost:8700/v1/search -H 'Content-Type: application/json' -d '{
  "query": "xyz-t3-ts", "mode": "hybrid"
}'
# 期望：命中该笔记；degraded=false
```

| ID | 手工 | 期望 |
|----|------|------|
| B3-A | commit/import 后 hybrid | 可命中 |
| B3-B | 未 commit 的沙箱词 search | **零命中** |
| B3-C | 上列 vault + hybrid | 可命中 |

---

## 3. 非目标

From Chat（C-1）、启动全库 backfill、真 PDF coverto 外网 e2e 必过 CI。
