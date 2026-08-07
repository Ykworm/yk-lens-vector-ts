/**
 * S3 兼容对象存储（本机 MinIO / 以后阿里云 OSS）。
 * 图字节放对象存储；Lance 只存可 HTTP 访问的 image_uri + 向量。
 */
import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ObjectStoreConfig {
  enabled: boolean;
  endpoint: string;
  public_base_url: string;
  region: string;
  bucket: string;
  access_key: string;
  secret_key: string;
  force_path_style: boolean;
}

export class ObjectStore {
  private client: S3Client | null = null;
  private ready = false;

  constructor(private cfg: ObjectStoreConfig) {}

  configured(): boolean {
    return (
      this.cfg.enabled &&
      Boolean(this.cfg.endpoint && this.cfg.bucket && this.cfg.access_key && this.cfg.secret_key)
    );
  }

  async init(): Promise<void> {
    if (!this.configured()) {
      this.ready = false;
      return;
    }
    this.client = new S3Client({
      region: this.cfg.region || "us-east-1",
      endpoint: this.cfg.endpoint.replace(/\/+$/, ""),
      forcePathStyle: this.cfg.force_path_style !== false,
      credentials: {
        accessKeyId: this.cfg.access_key,
        secretAccessKey: this.cfg.secret_key,
      },
    });
    await this.ensureBucket();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready && this.client != null;
  }

  /**
   * 上传字节；返回浏览器可访问的 public URL。
   * key: images/{doc_id}/{sha16}.{ext}
   */
  async putImage(opts: {
    docId: string;
    bytes: Buffer;
    mime: string;
    keyHint?: string;
  }): Promise<{ url: string; key: string; bucket: string }> {
    if (!this.client || !this.ready) throw new Error("object_store 未就绪");
    const ext = mimeToExt(opts.mime);
    const hash = createHash("sha256").update(opts.bytes).digest("hex").slice(0, 16);
    const safeDoc = (opts.docId || "anon").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    const key = opts.keyHint || `images/${safeDoc}/${hash}.${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: opts.bytes,
        ContentType: opts.mime || "application/octet-stream",
      }),
    );
    const url = this.publicUrl(key);
    return { url, key, bucket: this.cfg.bucket };
  }

  /** data URL → 上传 → public URL；失败抛错 */
  async putImageDataURL(
    docId: string,
    dataURL: string,
  ): Promise<{ url: string; key: string; bucket: string }> {
    const { bytes, mime } = decodeDataURL(dataURL);
    return this.putImage({ docId, bytes, mime });
  }

  publicUrl(key: string): string {
    const base = (this.cfg.public_base_url || this.cfg.endpoint).replace(/\/+$/, "");
    const bucket = this.cfg.bucket;
    // path-style：http://host:9000/bucket/key
    return `${base}/${bucket}/${key.replace(/^\/+/, "")}`;
  }

  private async ensureBucket(): Promise<void> {
    if (!this.client) return;
    const bucket = this.cfg.bucket;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (e) {
        // 并发创建可能已存在
        console.warn("object_store create bucket:", e);
      }
    }
    // 本机 dev：公开读，便于 <img src>
    try {
      await this.client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    } catch {
      /* no policy yet */
    }
    try {
      const policy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: ["*"] },
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      };
      await this.client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: JSON.stringify(policy),
        }),
      );
    } catch (e) {
      console.warn("object_store put bucket policy (public read):", e);
    }
  }
}

function mimeToExt(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("svg")) return "svg";
  return "bin";
}

export function decodeDataURL(s: string): { bytes: Buffer; mime: string } {
  if (!s.startsWith("data:")) throw new Error("not data url");
  const comma = s.indexOf(",");
  if (comma < 0) throw new Error("bad data url");
  const meta = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  let mime = "image/png";
  const semi = meta.indexOf(";");
  if (semi >= 0) mime = meta.slice(0, semi);
  else if (meta) mime = meta;
  if (!meta.includes("base64")) throw new Error("only base64 data url supported");
  return { bytes: Buffer.from(payload, "base64"), mime };
}
