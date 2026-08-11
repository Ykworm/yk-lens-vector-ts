# 与 yk-vector-go 对照 · 能否删除 go

| 项 | 内容 |
|----|------|
| **更新** | 2026-08-04 |
| **结论** | **可删 go**（接线已默认 ts :8703；仅你一人用） |

---

## 1. 功能对照（向量进程）

| 能力 | go | ts | 可替代？ |
|------|----|----|----------|
| HTTP 契约 | ✅ | ✅ 对齐 | 是 |
| heading_recursive | ✅ | ✅ | 是 |
| replace/delete/search/rename/jobs | ✅ | ✅ | 是 |
| remove_and_insert（关 hash skip） | ✅ | ✅ | 是 |
| 双空间 C-9 | ✅ | ✅ | 是 |
| Lance 持久化 | CGO/社区 或 exact gob | **官方 TS + 真 Lance** | **ts 更优** |
| ANN | 进程内 HNSW 或 CGO 映射 | **IVF_FLAT + cosine（锁定）** | 是（口径见 06） |
| 双表各自向量索引 | 视后端 | ✅ | 是 |
| 端口 | 8702 | 8703 | 改 LENS_VECTOR |

---

## 2. 系统接线（已切 ts）

| 项 | 状态 |
|----|------|
| `dev.sh` 默认 `LENS_VECTOR` / 拉起 | **yk-lens-vector-ts :8703** |
| app `/dev-vector` 代理 | **:8703** |
| Agents.md | 现行 ts；go 标历史 |

---

## 3. 判断

| 问题 | 答案 |
|------|------|
| ts 是否覆盖 go 向量服务职责？ | **是** |
| 能否删 `yk-vector-go`？ | **可以**（单人、接线已切；保留 git 历史即可） |
| 删前注意 | 停掉仍在跑的 go 进程；不要混用 go 的 `data/lance` 与 ts 目录 |

---

## 4. 删除示例

```bash
# 确认无进程占用 8702
# 可选：整目录移走备份
mv yk-vector-go /tmp/yk-vector-go.bak-$(date +%Y%m%d)
# 或直接 rm -rf yk-vector-go
```
