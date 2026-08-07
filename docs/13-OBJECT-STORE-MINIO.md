# 对象存储：本机 MinIO → 以后 OSS

| 项 | 内容 |
|----|------|
| **状态** | 设计已定 + 本机 MinIO 落地 |
| **目的** | 图有 **可 HTTP 访问的 URL**，前端能预览；与以后阿里云 OSS 同一模型 |
| **不做** | 进程内嵌 MinIO；向量服务持 vault 磁盘路径 |

---

## 0. 为什么要对象存储

| 存成 | 浏览器 `<img>` |
|------|----------------|
| 磁盘绝对路径 / `/image/foo.jpeg` | 不能直接显示 |
| `data:image/...` 全文进 Lance | 能显示，但体积大、Browse 要压碎 |
| **`http(s)://.../bucket/key`** | **能显示**；向量仍存 Lance |

红线不变：Lance 存 **向量 + 元数据**；**图字节**在对象存储（或 vault 静态，本方案用 MinIO 预演 OSS）。

---

## 1. 角色分工

| 组件 | 职责 |
|------|------|
| **MinIO**（本机 sidecar） | S3 兼容对象存储；默认 API `:9000`，控制台 `:9001` |
| **yk-vector-ts** | 图入库时可选 **PutObject**；`image_uri` 写 **公网/本机可访问 URL**；embed 仍用字节/data URL |
| **前端实验台** | `<img src={image_uri}>` 当 `http(s)`；不拼磁盘路径 |
| **以后 OSS** | 换 endpoint / bucket / 密钥；业务字段仍是 `image_uri` |
| **lensd** | 生产主路径以后可统一上传；本阶段实验台可直打 vector 上传 |

**不进程内嵌 MinIO**：由 `dev.sh` 拉起 Docker 容器（或已有外部 MinIO）。

---

## 2. 本机约定

| 项 | 默认 |
|----|------|
| API | `http://127.0.0.1:9000` |
| 控制台 | `http://127.0.0.1:9001` |
| 用户/密码 | `minioadmin` / `minioadmin`（仅本机 dev） |
| bucket | `yk-lens` |
| 公网访问形态 | path-style：`http://127.0.0.1:9000/yk-lens/<key>` |
| key 建议 | `images/{doc_id}/{sha16}.{ext}` |

bucket 策略：本机 dev **公开读**（匿名 GetObject），方便 `<img>` 不签 URL。生产 OSS 改用签名 URL 或 CDN。

---

## 3. 配置（yk-vector-ts.yaml）

```yaml
object_store:
  enabled: true
  endpoint: "http://127.0.0.1:9000"
  public_base_url: "http://127.0.0.1:9000"   # 写入 image_uri 的前缀
  region: "us-east-1"
  bucket: "yk-lens"
  access_key: "minioadmin"
  secret_key: "minioadmin"
  force_path_style: true   # MinIO 必开
```

- `enabled: false` 或不配：行为与以前相同（data URL 压碎进 `image_uri`，预览弱）。
- 环境变量可选覆盖：`YK_VECTOR_S3_*`（见 config）。

---

## 4. 写入流程

### 4.1 `upsert_image`

1. 收 data URL / base64  
2. VL embed 图像  
3. 若 object_store 启用：PutObject → `image_uri = public_base_url/bucket/key`  
4. 否则：`image_uri = compactImageUri(dataURL)`  
5. 写入 `image_chunks`

### 4.2 MD replace 抽图

对 **data URL** 图：同 4.1 上传后写 HTTP `image_uri`。  
对已是 **http(s)**：不上传，原样作 `image_uri`（可再 GET 做 embed）。  
对 **相对路径**：仍 skip + `relative_path_needs_upstream`（lensd 以后可先转 OSS URL）。

### 4.3 可选 API

```http
POST /v1/assets/upload
{ "doc_id", "image_data_url" | "image_base64"+"image_mime" }
→ { "ok", "url", "key", "bucket" }
```

实验台可先 upload 再 upsert；**upsert_image 内已自动上传**时可不单独调。

---

## 5. 读取 / 预览

| 侧 | 行为 |
|----|------|
| 搜索命中 `image_uri` 以 `http://` / `https://` 开头 | 前端直接 `<img src>` |
| Browse | 可显示 `image_uri` 全文（短 URL）；不再依赖 data URL |
| 文搜图 / 图搜图 | 仍只靠 `image_vector`，与 URL 无关 |

---

## 6. dev.sh

```bash
./dev.sh start   # 尝试拉起 MinIO（Docker）+ 其它服务
./dev.sh stop    # 停 MinIO 容器（若由本脚本起）
./dev.sh status  # 显示 MinIO 端口探活
```

启动顺序：优先 **Docker 容器**；无 Docker 时自动下载 **MinIO 官方二进制** 到 `yk-vector-ts/tools/minio` 并后台跑（数据 `yk-vector-ts/data/minio`）。  
`object_store.enabled=true` 但 MinIO 未起：vector 启动日志告警，图回落 compact data URL。

---

## 7. 以后换阿里云 OSS

| 项 | 改什么 |
|----|--------|
| endpoint | `https://oss-cn-xxx.aliyuncs.com` |
| force_path_style | 一般 `false`（虚拟主机风格） |
| public_base_url | bucket 域名或 CDN |
| 密钥 | RAM AK/SK |
| 公开读 | 桶策略或签名 GET |

**Lance 行、前端字段名不变**：只要 `image_uri` 仍是浏览器可访问的 URL。

---

## 8. 非目标

| 不做 | 说明 |
|------|------|
| 进程内嵌 MinIO | 独立 sidecar |
| 视频 | 不做 |
| 向量服务读 vault 相对路径 | 仍要上游解析或先上传 OSS |
| 生产默认 minioadmin | 仅本机 |

---

## 9. 验收

1. `docker ps` 有 minio；控制台能开  
2. Health 含 `object_store: true`（或等价字段）  
3. Upsert 图后 `image_uri` 为 `http://127.0.0.1:9000/yk-lens/...`  
4. 搜索 image 命中左侧能显示海报缩略图  
5. 关 object_store 后行为回落（不崩）
