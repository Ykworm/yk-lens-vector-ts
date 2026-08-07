/** 跨模态 qwen3-vl-embedding（文搜图 / 图搜图 / 图像入库） */

import { EmbedError, ErrEmptyResult, ErrNotConfigured } from "./client.js";

export class VLClient {
  constructor(
    private baseURL: string,
    private apiKey: string,
    private model: string,
    private timeoutMs: number,
  ) {
    this.baseURL = baseURL.replace(/\/+$/, "");
  }

  configured(): boolean {
    return Boolean(this.baseURL && this.model);
  }

  async embedText(text: string): Promise<number[]> {
    if (!this.configured()) throw ErrNotConfigured;
    if (!text.trim()) throw new EmbedError("vl embed: text 空");
    return this.embedContents([{ text }]);
  }

  async embedImage(imageData: Buffer, mime = "image/png"): Promise<number[]> {
    if (!this.configured()) throw ErrNotConfigured;
    if (!imageData.length) throw new EmbedError("vl embed: image 空");
    const dataURL = `data:${mime};base64,${imageData.toString("base64")}`;
    return this.embedContents([{ image: dataURL }]);
  }

  async embedImageDataURL(dataURL: string): Promise<number[]> {
    if (!this.configured()) throw ErrNotConfigured;
    if (!dataURL.trim()) throw new EmbedError("vl embed: image url 空");
    return this.embedContents([{ image: dataURL }]);
  }

  private async embedContents(contents: Record<string, string>[]): Promise<number[]> {
    const body = {
      model: this.model,
      input: { contents },
    };
    const url = this.resolveURL();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) {
        throw new EmbedError(`vl embedding HTTP ${resp.status}: ${raw.slice(0, 240)}`);
      }
      const dash = JSON.parse(raw) as {
        output?: { embeddings?: { embedding: number[] }[] };
        data?: { embedding: number[] }[];
      };
      if (dash.output?.embeddings?.[0]?.embedding?.length) {
        return dash.output.embeddings[0].embedding;
      }
      if (dash.data?.[0]?.embedding?.length) {
        return dash.data[0].embedding;
      }
      throw ErrEmptyResult;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 多模态 embedding 走 DashScope / MaaS **native** 路径，不是 OpenAI compatible-mode。
   *
   * - 已写全路径 / 以 /embeddings 结尾：原样
   * - `.../compatible-mode/v1`（常见误配成与文本同 base）→ 改写为 `.../api/v1` 再拼 multimodal
   * - 否则：`{base}/services/embeddings/multimodal-embedding/multimodal-embedding`
   */
  private resolveURL(): string {
    let u = this.baseURL.replace(/\/+$/, "");
    if (u.includes("multimodal-embedding") || u.endsWith("/embeddings")) return u;

    // 文本 embedding 常用 compatible-mode；VL 在此 404
    if (u.includes("/compatible-mode/v1")) {
      u = u.replace("/compatible-mode/v1", "/api/v1");
    } else if (u.endsWith("/compatible-mode")) {
      u = u.replace(/\/compatible-mode$/, "/api/v1");
    }

    return `${u}/services/embeddings/multimodal-embedding/multimodal-embedding`;
  }

  /** 调试 / 启动日志用 */
  endpoint(): string {
    if (!this.configured()) return "";
    return this.resolveURL();
  }
}
