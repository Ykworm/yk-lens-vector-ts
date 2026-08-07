# C-9 多模态：实现说明与债务

| 项 | 内容 |
|----|------|
| **状态** | 代码已能跑通双空间；**MD 含图完整流程以 [07](07-MULTIMODAL-VECTOR.md) 为准** |
| **设计** | [07-MULTIMODAL-VECTOR.md](07-MULTIMODAL-VECTOR.md)（第 2～7 节 = 实现步骤；第 9 节 = 待拍板） |

本文只写 **现状实现** 与 **相对 07 的差距**，避免把过渡细节当成产品契约。

---

## 1. 行模型（现状）

| modality | 行 ID | 向量 | 表 |
|----------|--------|------|-----|
| text | `doc_id#chunk_index` | `vector` | `text_chunks` |
| image | `doc_id#img#` + sha256(uri/key)[:16] | `image_vector` | `image_chunks` |

- replace：按 `doc_id` **先整篇删除再重建**（文 + 图）——与 07 第 1 节一致。  
- 图主键：**不做「第几张」**；用 `makeImageChunkIdFromKey`。  
- 显式入口：`POST /v1/index/upsert_text` · `POST /v1/index/upsert_image`（失败抛错，不软忽略）。

---

## 2. 代码位置

| 路径 | 职责 |
|------|------|
| `src/store/lanceStore.ts` | 双表、索引、search 列选择 |
| `src/embed/vl.ts` | VL HTTP（native `/api/v1/.../multimodal-embedding`，勿抄文本 `compatible-mode`） |
| `src/image/extract.ts` | MD 抽 `![]()` / `<img>` |
| `src/service/indexService.ts` | replace 抽 MD 图；search 三 mode；MD 含图时的结果字段 |

---

## 3. 配置

```yaml
embedding:
  model: qwen3-embedding-0.6b   # 或本机实际文本模型
  # base_url: .../compatible-mode/v1
vl:
  model: qwen3-vl-embedding
  # base_url: .../api/v1   # 必须 native，不能与文本共用 compatible-mode 路径
  max_images: 32
```

VL 未配置：文本仍可用；跳过图像入库；文搜图 / 图搜图 503。

---

## 4. 与 07 决策的对照

| 07 决策 | 现状 | 备注 |
|---------|------|------|
| 整篇先删后建 | ✅ | `deleteByDocId` + insert |
| text / image 两套模型与表 | ✅ | |
| 不做「第几张」业务字段 | ✅ | 主键为 hash(uri/key) |
| MD 含图：某图失败则跳过该图，整体仍成功，返回里写清图结果 | ✅ | replace 响应：`images_found` / `image_chunks` / `image_errors` |
| 图行挂文字向量 | ⏸ 后置 | 不做 |
| `upsert_text` / `upsert_image` | ✅ | 失败直接 error；实验台 Upsert 页 |
| vault 相对路径 | 跳过 | 需上游解析 |

---

## 5. 未做 / 后置（汇总）

| 项 | 说明 |
|----|------|
| 图行文字向量 / 描述 embed | 07 第 4.2 节，后置 |
| 相对路径 vault 图 | lensd 先解析 |
| 视频 | 不做 |
| lensd hybrid 默认文搜图 | 不做（hybrid 仍文搜文） |

---

## 6. 联调注意（踩坑摘要）

| 现象 | 原因 |
|------|------|
| Health `vl=true` 但 `image_chunks` 为空 | VL URL 404（compatible-mode 误用于 multimodal）或图失败被忽略 |
| 文搜图 404 | 同上，查询侧 VL embed 失败 |
| MD 里有图但 replace 像成功、库里没图 | 看响应里图相关字段（`image_errors` / `image_chunks`），勿只看 `chunks` 总数 |
| 搜索有命中但缩略图空白 | `image_uri` 非 http(s)/data（如 `/image/x.jpeg`）；需 MinIO/OSS 或 data URL |

手工验收状态见 [14-LAB-MANUAL-TEST.md](14-LAB-MANUAL-TEST.md)。
