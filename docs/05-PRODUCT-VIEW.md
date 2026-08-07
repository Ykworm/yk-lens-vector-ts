# 产品视角（摘要）

| 用户要什么 | 系统怎么保证 |
|------------|--------------|
| 笔记能语义搜到 | 进 vault 后向量索引；hybrid 在 lensd |
| 改笔记向量更新 | replace；hash 同则 skip 省钱 |
| 换模型能重建 | remove_and_insert + lensd reindex（有 UI/admin，无向量 CLI） |
| 图也能搜 | C-9 双空间（增强） |

本服务对用户不可见；只服务 lensd。

更长产品文：`yk-vector-go/docs/05-PRODUCT-VIEW.md`。
