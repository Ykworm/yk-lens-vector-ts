# Query / Insert 算法（摘要）

与历史 go 文档同源；本仓实现要点：

| 主题 | 本仓选择 |
|------|----------|
| 切分 | heading_recursive（02） |
| 写入 | doc_id replace（先删后插） |
| 检索 | cosine；ANN = IVF_FLAT（06）或 exact |
| 聚合 | 文档级最高分 chunk（B5） |
| 多模态 | 双空间（07） |

更长的算法对比与叙事见历史：`yk-vector-go/docs/04-QUERY-INSERT-ALGORITHMS.md`（索引类型名以 **本仓 06 IVF_FLAT** 为准，勿再写死 IVF_HNSW_FLAT 为唯一目标）。
