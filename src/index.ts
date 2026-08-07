/**
 * yk-vector-ts — 给 lensd 用的向量库服务（chunk + embed + Lance 官方 TS SDK + search）。
 *
 * 边界对齐 yk-vector-go / docs/00-FEATURE.md：
 *   - 只服务 lensd HTTP；Agent/生产前端禁止直连
 *   - 主键 doc_id；content_hash 仅指纹
 *   - 不持 vault、不写 Meili、不做 hybrid RRF
 *   - 启动只 Open Lance 目录，不 re-embed
 *
 * 默认端口 :8703（与 go :8702 并存）；LENS_VECTOR 指向本服务即可切换。
 */
import { createApp } from "./api/server.js";
import { embeddingApiKey, loadConfig, parseAddr, vlApiKey } from "./config.js";
import { EmbedClient } from "./embed/client.js";
import { VLClient } from "./embed/vl.js";
import { IndexService } from "./service/indexService.js";
import { JobQueue } from "./service/jobs.js";
import { LanceStore } from "./store/lanceStore.js";
import { ObjectStore } from "./store/objectStore.js";

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : process.env.YK_VECTOR_CONFIG || "configs/yk-vector-ts.yaml";

  const cfg = loadConfig(configPath);

  if (cfg.store_backend && cfg.store_backend !== "lance") {
    console.warn(
      `store_backend=${cfg.store_backend} 未实现（与 go 对齐字段；本进程仅 lance），按 lance 继续`,
    );
  }

  const store = await LanceStore.open(cfg.lance_path, cfg.vector_index);
  const st = await store.statusAsync();
  console.log(
    `向量存储 open：backend=lance path=${cfg.lance_path} chunks=${st.chunks} ann=${store.annEnabled() ? "ivf_flat+cosine" : "none"}`,
  );

  const emb = new EmbedClient(
    cfg.embedding.base_url,
    embeddingApiKey(cfg),
    cfg.embedding.model,
    cfg.embedding.timeout_sec * 1000,
  );
  if (emb.configured()) {
    console.log(`embedding(text)：model=${cfg.embedding.model} base=${cfg.embedding.base_url}`);
  } else {
    console.log("embedding(text) 未配置：文搜文/文本 replace 将 503");
  }

  const vl = new VLClient(
    cfg.vl.base_url,
    vlApiKey(cfg),
    cfg.vl.model,
    cfg.vl.timeout_sec * 1000,
  );
  if (vl.configured()) {
    console.log(
      `embedding(vl)：model=${cfg.vl.model} base=${cfg.vl.base_url} endpoint=${vl.endpoint()}`,
    );
  } else {
    console.log("embedding(vl) 未配置：跳过图像入库；文搜图/图搜图不可用");
  }

  console.log(
    `chunk：strategy=${cfg.chunk.strategy} max_tokens=${cfg.chunk.max_tokens} overlap=${cfg.chunk.overlap_tokens}`,
  );

  const svc = new IndexService(store, emb, vl, {
    maxTokens: cfg.chunk.max_tokens,
    overlapTokens: cfg.chunk.overlap_tokens,
    enrich: cfg.chunk.enrich,
    enrichNeighborChars: cfg.chunk.enrich_neighbor_chars,
    enrichMeta: cfg.chunk.enrich_meta,
    enrichMaxChars: cfg.chunk.enrich_max_chars,
  });
  svc.asyncDefault = cfg.replace_async;
  svc.maxImagesPerDoc = cfg.vl.max_images;
  svc.jobs = new JobQueue(svc);
  if (cfg.replace_async) {
    console.log("replace 默认异步（replace_async / YK_VECTOR_REPLACE_ASYNC）");
  }
  console.log(
    `enrich：enabled=${cfg.chunk.enrich} neighbor=${cfg.chunk.enrich_neighbor_chars} meta=${cfg.chunk.enrich_meta} max_chars=${cfg.chunk.enrich_max_chars}`,
  );

  const obj = new ObjectStore(cfg.object_store);
  if (obj.configured()) {
    try {
      await obj.init();
      svc.objectStore = obj;
      console.log(
        `object_store：ready bucket=${cfg.object_store.bucket} endpoint=${cfg.object_store.endpoint} public=${cfg.object_store.public_base_url}`,
      );
    } catch (e) {
      console.warn("object_store 初始化失败（图将回落 compact data URL）:", e);
      svc.objectStore = null;
    }
  } else {
    console.log("object_store 未启用：图 image_uri 用 compact data URL（预览弱）");
  }

  const app = createApp(svc);
  const { host, port } = parseAddr(cfg.addr);

  const server = app.listen(port, host, () => {
    console.log(`yk-vector-ts 监听 ${host}:${port}（仅 lensd 应调用；契约对齐 yk-vector-go）`);
  });

  const shutdown = async (sig: string) => {
    console.log(`收到信号 ${sig}，关闭…`);
    svc.jobs?.close();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
