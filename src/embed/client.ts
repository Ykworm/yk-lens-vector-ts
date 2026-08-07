/** OpenAI 兼容 /embeddings（文搜文 → text_vector） */

export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedError";
  }
}

export const ErrNotConfigured = new EmbedError("embedding 未配置");
export const ErrEmptyResult = new EmbedError("embedding 结果为空");

export class EmbedClient {
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

  async embed(text: string): Promise<number[]> {
    const vecs = await this.embedBatch([text]);
    if (!vecs[0]?.length) throw ErrEmptyResult;
    return vecs[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.configured()) throw ErrNotConfigured;
    if (texts.length === 0) return [];

    const input: string | string[] = texts.length === 1 ? texts[0] : texts;
    const body = { model: this.model, input };
    const url = `${this.baseURL}/embeddings`;
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
        throw new EmbedError(`embedding HTTP ${resp.status}: ${raw.slice(0, 240)}`);
      }
      const parsed = JSON.parse(raw) as {
        data?: { embedding: number[]; index?: number }[];
      };
      if (!parsed.data?.length) throw ErrEmptyResult;
      const out: (number[] | null)[] = new Array(texts.length).fill(null);
      for (const d of parsed.data) {
        if (!d.embedding?.length) throw ErrEmptyResult;
        let i = d.index ?? -1;
        if (i < 0 || i >= out.length) {
          i = out.findIndex((x) => x == null);
          if (i < 0) throw new EmbedError("embedding index 越界");
        }
        out[i] = d.embedding;
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]?.length) throw new EmbedError(`embedding 第 ${i} 条为空`);
      }
      return out as number[][];
    } finally {
      clearTimeout(t);
    }
  }
}
