import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { ErrNotConfigured } from "../embed/client.js";
import type {
  IndexService,
  ReplaceRequest,
  RenameRequest,
  SearchRequest,
  UploadAssetRequest,
  UpsertImageRequest,
  UpsertTextRequest,
} from "../service/indexService.js";

export function createApp(svc: IndexService): Express {
  const app = express();
  app.use(express.json({ limit: "32mb" }));

  app.get("/healthz", async (_req, res) => {
    const h = await svc.healthz();
    res.status(h.ok ? 200 : 503).json(h);
  });

  app.post("/v1/index/replace", async (req, res, next) => {
    try {
      const body = req.body as ReplaceRequest;
      const result = await svc.replace(body);
      const code = result.job_id && result.status === "queued" ? 202 : 200;
      res.status(code).json(result);
    } catch (e) {
      next(e);
    }
  });

  /** 显式文本块入库（简单测试；失败 4xx/5xx） */
  app.post("/v1/index/upsert_text", async (req, res, next) => {
    try {
      const body = req.body as UpsertTextRequest;
      const result = await svc.upsertText(body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /** 显式图像入库（简单测试；失败 4xx/5xx，不软忽略） */
  app.post("/v1/index/upsert_image", async (req, res, next) => {
    try {
      const body = req.body as UpsertImageRequest;
      const result = await svc.upsertImage(body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /** 只上传到 MinIO/OSS，返回可预览 URL（不写 Lance） */
  app.post("/v1/assets/upload", async (req, res, next) => {
    try {
      const body = req.body as UploadAssetRequest;
      const result = await svc.uploadAsset(body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.post("/v1/index/delete", async (req, res, next) => {
    try {
      const docId = (req.body as { doc_id?: string })?.doc_id || "";
      const result = await svc.delete(docId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.post("/v1/index/rename", async (req, res, next) => {
    try {
      const body = req.body as RenameRequest;
      const result = await svc.rename(body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.post("/v1/search", async (req, res, next) => {
    try {
      const body = req.body as SearchRequest;
      const result = await svc.search(body);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  app.get("/v1/jobs/:id", (req, res) => {
    if (!svc.jobs) {
      res.status(503).json({ ok: false, error: "异步队列未启用" });
      return;
    }
    const j = svc.jobs.get(req.params.id);
    if (!j) {
      res.status(404).json({ ok: false, error: "job 不存在" });
      return;
    }
    res.json(j);
  });

  // 只读 Admin：表清单 / 分页扫行（实验台 Browse；npm 起 yk-vector-ts 即有）
  app.get("/v1/admin/tables", async (_req, res, next) => {
    try {
      const tables = await svc.listTables();
      res.json({ ok: true, tables });
    } catch (e) {
      next(e);
    }
  });

  app.get("/v1/admin/rows", async (req, res, next) => {
    try {
      const table = String(req.query.table || "text_chunks");
      const limit = req.query.limit != null ? Number(req.query.limit) : 20;
      const offset = req.query.offset != null ? Number(req.query.offset) : 0;
      const doc_id = req.query.doc_id != null ? String(req.query.doc_id) : undefined;
      const order_by = req.query.order_by != null ? String(req.query.order_by) : undefined;
      const order = req.query.order != null ? String(req.query.order) : undefined;
      const group_by = req.query.group_by != null ? String(req.query.group_by) : undefined;
      const result = await svc.listRows({ table, limit, offset, doc_id, order_by, order, group_by });
      res.json({ ok: true, ...result });
    } catch (e) {
      next(e);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    let status = 500;
    if (err === ErrNotConfigured || msg.includes("未配置")) status = 503;
    else if (
      msg.includes("必填") ||
      msg.includes("未知 mode") ||
      msg.includes("未知表") ||
      msg.includes("order_by") ||
      msg.includes("group_by") ||
      msg.includes("不能按向量列")
    )
      status = 400;
    console.error("api error:", msg);
    res.status(status).json({ ok: false, error: msg });
  });

  return app;
}
