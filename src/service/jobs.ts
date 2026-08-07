import type { IndexService, ReplaceRequest } from "./indexService.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface Job {
  job_id: string;
  kind: string;
  doc_id: string;
  status: JobStatus;
  error?: string;
  chunks?: number;
  skipped?: boolean;
  created_at: number;
  updated_at: number;
}

interface JobItem {
  id: string;
  req: ReplaceRequest;
}

/** 内存异步队列：单 worker 串行 embed */
export class JobQueue {
  private queue: JobItem[] = [];
  private jobs = new Map<string, Job>();
  private seq = 0;
  private closed = false;
  private running = false;

  constructor(private svc: IndexService) {}

  enqueueReplace(req: ReplaceRequest): string {
    const id = `job_${++this.seq}`;
    const now = Math.floor(Date.now() / 1000);
    this.jobs.set(id, {
      job_id: id,
      kind: "replace",
      doc_id: req.doc_id,
      status: "queued",
      created_at: now,
      updated_at: now,
    });
    this.queue.push({ id, req: { ...req, async: false } });
    void this.pump();
    return id;
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j } : undefined;
  }

  close(): void {
    this.closed = true;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0 && !this.closed) {
      const item = this.queue.shift()!;
      this.setStatus(item.id, "running");
      try {
        const res = await this.svc.replaceSync(item.req);
        const st: JobStatus = res.skipped ? "skipped" : "done";
        this.setStatus(item.id, st, undefined, res.chunks, res.skipped);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`async replace job ${item.id} doc=${item.req.doc_id}:`, msg);
        this.setStatus(item.id, "failed", msg);
      }
    }
    this.running = false;
  }

  private setStatus(
    id: string,
    status: JobStatus,
    error?: string,
    chunks?: number,
    skipped?: boolean,
  ): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.status = status;
    j.error = error;
    if (chunks != null) j.chunks = chunks;
    if (skipped != null) j.skipped = skipped;
    j.updated_at = Math.floor(Date.now() / 1000);
  }
}
