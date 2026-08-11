import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * 桌面 / 个人向：密钥优先写在 yaml 的 api_key（IDE 可编辑）。
 * 环境变量仅可选覆盖（以后上服务器再用，日常可不碰）。
 */
export interface EmbeddingConfig {
  base_url: string;
  /** 直接写在配置文件里的 key（推荐本机使用） */
  api_key: string;
  /** 可选：从该环境变量读 key；仅当 api_key 为空时使用 */
  api_key_env: string;
  model: string;
  timeout_sec: number;
}

export interface VLConfig {
  base_url: string;
  api_key: string;
  api_key_env: string;
  model: string;
  timeout_sec: number;
  max_images: number;
}

export interface ChunkConfig {
  strategy: string;
  max_tokens: number;
  overlap_tokens: number;
  /** 叶子窗口 Enrich（C-15） */
  enrich: boolean;
  /** 切片前后各最多 N 字符 */
  enrich_neighbor_chars: number;
  /** 是否拼 title/path/heading_path */
  enrich_meta: boolean;
  /** embed 输入总长 cap */
  enrich_max_chars: number;
}

/** S3 兼容（本机 MinIO / 阿里云 OSS），见 docs/13-OBJECT-STORE-MINIO.md */
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

export interface Config {
  addr: string;
  lance_path: string;
  /** 与 go 对齐：lance | exact；ts 仅实现 lance */
  store_backend: string;
  vector_index: string;
  replace_async: boolean;
  embedding: EmbeddingConfig;
  vl: VLConfig;
  chunk: ChunkConfig;
  object_store: ObjectStoreConfig;
}

export function defaultConfig(): Config {
  return {
    addr: ":8703",
    lance_path: "data/lance",
    store_backend: "lance",
    vector_index: "ivf_flat",
    replace_async: false,
    embedding: {
      base_url: "",
      api_key: "",
      api_key_env: "YK_VECTOR_EMBED_API_KEY",
      model: "qwen3-embedding-0.6b",
      timeout_sec: 30,
    },
    vl: {
      base_url: "",
      api_key: "",
      api_key_env: "YK_VECTOR_VL_API_KEY",
      model: "qwen3-vl-embedding",
      timeout_sec: 60,
      max_images: 32,
    },
    chunk: {
      strategy: "heading_recursive",
      max_tokens: 512,
      overlap_tokens: 64,
      enrich: true,
      enrich_neighbor_chars: 256,
      enrich_meta: true,
      enrich_max_chars: 4000,
    },
    object_store: {
      enabled: false,
      endpoint: "http://127.0.0.1:9000",
      public_base_url: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "yk-lens",
      access_key: "minioadmin",
      secret_key: "minioadmin",
      force_path_style: true,
    },
  };
}

export function loadConfig(configPath?: string): Config {
  const cfg = defaultConfig();
  const p = configPath || process.env.YK_VECTOR_CONFIG || "configs/yk-lens-vector-ts.yaml";
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    const y = parseYaml(raw) as Partial<Config> & {
      embedding?: Partial<EmbeddingConfig> & { api_key_env?: string };
      vl?: Partial<VLConfig> & { api_key_env?: string };
      object_store?: Partial<ObjectStoreConfig>;
    };
    Object.assign(cfg, y);
    if (y.embedding) cfg.embedding = { ...cfg.embedding, ...y.embedding };
    if (y.vl) cfg.vl = { ...cfg.vl, ...y.vl };
    if (y.chunk) cfg.chunk = { ...cfg.chunk, ...y.chunk };
    if (y.object_store) cfg.object_store = { ...cfg.object_store, ...y.object_store };

    // 兼容：有人把 sk- 写在 api_key_env 里 → 当作 api_key
    promoteSkEnvToKey(cfg.embedding);
    promoteSkEnvToKey(cfg.vl);
  }
  applyEnv(cfg);
  normalize(cfg);
  if (!path.isAbsolute(cfg.lance_path)) {
    cfg.lance_path = path.resolve(process.cwd(), cfg.lance_path);
  }
  return cfg;
}

function promoteSkEnvToKey(block: { api_key: string; api_key_env: string }): void {
  const e = (block.api_key_env || "").trim();
  if (!block.api_key && (e.startsWith("sk-") || e.startsWith("AK"))) {
    block.api_key = e;
    block.api_key_env = "";
  }
}

function applyEnv(cfg: Config): void {
  if (process.env.YK_VECTOR_ADDR) cfg.addr = process.env.YK_VECTOR_ADDR;
  if (process.env.YK_VECTOR_LANCE) cfg.lance_path = process.env.YK_VECTOR_LANCE;
  if (process.env.YK_VECTOR_STORE) cfg.store_backend = process.env.YK_VECTOR_STORE;
  if (process.env.YK_VECTOR_EMBED_BASE_URL) cfg.embedding.base_url = process.env.YK_VECTOR_EMBED_BASE_URL;
  if (process.env.YK_VECTOR_EMBED_MODEL) cfg.embedding.model = process.env.YK_VECTOR_EMBED_MODEL;
  // 环境变量有值时覆盖 yaml（可选；日常可不用）
  if (process.env.YK_VECTOR_EMBED_API_KEY) cfg.embedding.api_key = process.env.YK_VECTOR_EMBED_API_KEY;
  if (process.env.YK_VECTOR_EMBED_TIMEOUT_SEC) {
    const n = parseInt(process.env.YK_VECTOR_EMBED_TIMEOUT_SEC, 10);
    if (n > 0) cfg.embedding.timeout_sec = n;
  }
  if (process.env.YK_VECTOR_CHUNK_MAX_TOKENS) {
    const n = parseInt(process.env.YK_VECTOR_CHUNK_MAX_TOKENS, 10);
    if (n > 0) cfg.chunk.max_tokens = n;
  }
  if (process.env.YK_VECTOR_CHUNK_OVERLAP) {
    const n = parseInt(process.env.YK_VECTOR_CHUNK_OVERLAP, 10);
    if (n >= 0) cfg.chunk.overlap_tokens = n;
  }
  if (process.env.YK_VECTOR_INDEX) cfg.vector_index = process.env.YK_VECTOR_INDEX;
  if (process.env.YK_VECTOR_REPLACE_ASYNC) {
    const v = process.env.YK_VECTOR_REPLACE_ASYNC;
    cfg.replace_async = v === "1" || v === "true" || v === "yes";
  }
  if (process.env.YK_VECTOR_VL_BASE_URL) cfg.vl.base_url = process.env.YK_VECTOR_VL_BASE_URL;
  if (process.env.YK_VECTOR_VL_MODEL) cfg.vl.model = process.env.YK_VECTOR_VL_MODEL;
  if (process.env.YK_VECTOR_VL_API_KEY) cfg.vl.api_key = process.env.YK_VECTOR_VL_API_KEY;
  if (process.env.YK_VECTOR_VL_MAX_IMAGES) {
    const n = parseInt(process.env.YK_VECTOR_VL_MAX_IMAGES, 10);
    if (n > 0) cfg.vl.max_images = n;
  }
  if (process.env.YK_VECTOR_S3_ENABLED) {
    const v = process.env.YK_VECTOR_S3_ENABLED;
    cfg.object_store.enabled = v === "1" || v === "true" || v === "yes";
  }
  if (process.env.YK_VECTOR_S3_ENDPOINT) cfg.object_store.endpoint = process.env.YK_VECTOR_S3_ENDPOINT;
  if (process.env.YK_VECTOR_S3_PUBLIC_BASE) {
    cfg.object_store.public_base_url = process.env.YK_VECTOR_S3_PUBLIC_BASE;
  }
  if (process.env.YK_VECTOR_S3_BUCKET) cfg.object_store.bucket = process.env.YK_VECTOR_S3_BUCKET;
  if (process.env.YK_VECTOR_S3_ACCESS_KEY) cfg.object_store.access_key = process.env.YK_VECTOR_S3_ACCESS_KEY;
  if (process.env.YK_VECTOR_S3_SECRET_KEY) cfg.object_store.secret_key = process.env.YK_VECTOR_S3_SECRET_KEY;
  if (process.env.YK_VECTOR_S3_REGION) cfg.object_store.region = process.env.YK_VECTOR_S3_REGION;
}

function normalize(cfg: Config): void {
  if (!cfg.addr) cfg.addr = ":8703";
  if (!cfg.lance_path) cfg.lance_path = "data/lance";
  if (!cfg.store_backend) cfg.store_backend = "lance";
  if (!cfg.vector_index) cfg.vector_index = "ivf_flat";
  if (cfg.embedding.timeout_sec <= 0) cfg.embedding.timeout_sec = 30;
  if (!cfg.vl.model) cfg.vl.model = "qwen3-vl-embedding";
  if (cfg.vl.timeout_sec <= 0) cfg.vl.timeout_sec = 60;
  if (cfg.vl.max_images <= 0) cfg.vl.max_images = 32;

  // VL 必须用 native /api/v1（multimodal-embedding），不能抄文本的 compatible-mode
  if (cfg.vl.base_url.includes("/compatible-mode/v1")) {
    cfg.vl.base_url = cfg.vl.base_url.replace("/compatible-mode/v1", "/api/v1");
  } else if (cfg.vl.base_url.endsWith("/compatible-mode")) {
    cfg.vl.base_url = cfg.vl.base_url.replace(/\/compatible-mode$/, "/api/v1");
  }

  if (!cfg.vl.base_url) {
    const emb = cfg.embedding.base_url || "";
    if (emb.includes("dashscope")) {
      cfg.vl.base_url = "https://dashscope.aliyuncs.com/api/v1";
    } else if (emb.includes("/compatible-mode/v1")) {
      // MaaS：文本 .../compatible-mode/v1 → VL .../api/v1
      cfg.vl.base_url = emb.replace("/compatible-mode/v1", "/api/v1");
    } else if (emb) {
      cfg.vl.base_url = emb;
    }
  }
  if (!cfg.chunk.strategy) cfg.chunk.strategy = "heading_recursive";
  if (cfg.chunk.max_tokens <= 0) cfg.chunk.max_tokens = 512;
  if (cfg.chunk.overlap_tokens < 0) cfg.chunk.overlap_tokens = 0;
  if (cfg.chunk.enrich == null) cfg.chunk.enrich = true;
  if (cfg.chunk.enrich_neighbor_chars == null || cfg.chunk.enrich_neighbor_chars < 0) {
    cfg.chunk.enrich_neighbor_chars = 256;
  }
  if (cfg.chunk.enrich_meta == null) cfg.chunk.enrich_meta = true;
  if (cfg.chunk.enrich_max_chars == null || cfg.chunk.enrich_max_chars <= 0) {
    cfg.chunk.enrich_max_chars = 4000;
  }

  if (!cfg.object_store) cfg.object_store = defaultConfig().object_store;
  if (!cfg.object_store.endpoint) cfg.object_store.endpoint = "http://127.0.0.1:9000";
  if (!cfg.object_store.public_base_url) {
    cfg.object_store.public_base_url = cfg.object_store.endpoint;
  }
  if (!cfg.object_store.bucket) cfg.object_store.bucket = "yk-lens";
  if (!cfg.object_store.region) cfg.object_store.region = "us-east-1";
  // force_path_style 默认 true（MinIO）；OSS 可在 yaml 设 false
}

/** 解析最终密钥：yaml api_key → 环境变量名 → 文本 key 回落 VL */
function resolveKey(apiKey: string, apiKeyEnv: string): string {
  const direct = (apiKey || "").trim();
  if (direct) return direct;
  const envName = (apiKeyEnv || "").trim();
  if (envName && process.env[envName]) return process.env[envName]!;
  return "";
}

export function embeddingApiKey(cfg: Config): string {
  return resolveKey(cfg.embedding.api_key, cfg.embedding.api_key_env);
}

export function vlApiKey(cfg: Config): string {
  const k = resolveKey(cfg.vl.api_key, cfg.vl.api_key_env);
  if (k) return k;
  // 未配 VL key 时复用文本 key（本机常见）
  return embeddingApiKey(cfg);
}

/** 解析 ":8703" / "0.0.0.0:8703" → host + port */
export function parseAddr(addr: string): { host: string; port: number } {
  let a = addr.trim();
  if (a.startsWith(":")) a = `0.0.0.0${a}`;
  const idx = a.lastIndexOf(":");
  if (idx < 0) return { host: "0.0.0.0", port: 8703 };
  const host = a.slice(0, idx) || "0.0.0.0";
  const port = parseInt(a.slice(idx + 1), 10) || 8703;
  return { host, port };
}
