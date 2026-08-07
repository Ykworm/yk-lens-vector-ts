/**
 * 叶子窗口 Enrich：embed 输入 = 可选 meta + (前N + 切片 + 后N)。
 * 库内 text 仍只存切片 core。见 docs/15-PARENT-CHILD-AND-ENRICH.md 第 1 节。
 */

export interface EnrichMeta {
  title?: string;
  path?: string;
  heading_path?: string;
}

export interface EnrichOptions {
  /** 总开关 */
  enabled: boolean;
  /** 切片前后各最多 N 字符；0 = 不做邻域，仅 meta+core */
  neighborChars: number;
  /** 是否拼 title/path/heading_path */
  meta: boolean;
  /** embed 输入总长 cap（字符） */
  maxChars: number;
}

export const defaultEnrichOptions = (): EnrichOptions => ({
  enabled: true,
  neighborChars: 256,
  meta: true,
  maxChars: 4000,
});

/**
 * 从全文 body 取切片 [start,end) 的邻域窗口，再拼 meta。
 * start/end 为 body 内字符偏移（与 [...string] 无关，用 string slice）。
 */
export function buildEmbedInput(
  body: string,
  core: string,
  start: number,
  end: number,
  meta: EnrichMeta,
  opts?: Partial<EnrichOptions>,
): string {
  const o = { ...defaultEnrichOptions(), ...opts };
  if (!o.enabled) return core;

  const n = o.neighborChars > 0 ? o.neighborChars : 0;
  let s = Math.max(0, start);
  let e = Math.min(body.length, Math.max(s, end));
  // 若偏移不可靠，退化为仅 core
  if (s >= body.length || e <= s) {
    s = 0;
    e = 0;
  }

  let left = n > 0 && e > 0 ? body.slice(Math.max(0, s - n), s) : "";
  let right = n > 0 && e > 0 ? body.slice(e, Math.min(body.length, e + n)) : "";
  let window = left + core + right;

  const lines: string[] = [];
  if (o.meta) {
    const title = (meta.title || "").trim();
    const path = (meta.path || "").trim();
    const hp = (meta.heading_path || "").trim();
    if (title) lines.push(`文档：${title}`);
    if (path) lines.push(`路径：${path}`);
    if (hp) lines.push(`章节：${hp}`);
  }

  let input: string;
  if (lines.length > 0) {
    input = `${lines.join("\n")}\n---\n${window}`;
  } else {
    input = window;
  }

  if (o.maxChars > 0 && input.length > o.maxChars) {
    input = truncateEmbedInput(input, o.maxChars, lines.length > 0);
  }
  return input;
}

/** upsert 单块：无全文 body 时，仅 meta + core（无邻域） */
export function buildEmbedInputCoreOnly(core: string, meta: EnrichMeta, opts?: Partial<EnrichOptions>): string {
  return buildEmbedInput(core, core, 0, core.length, meta, {
    ...opts,
    neighborChars: 0, // 无全文则无法取邻域
  });
}

/**
 * cap 时优先保留 meta 头与 core 中段：砍 right 再砍 left。
 * 简化：若超 cap，从 window 部分两头收；meta 头尽量保留。
 */
function truncateEmbedInput(input: string, maxChars: number, hasMeta: boolean): string {
  if (input.length <= maxChars) return input;
  if (!hasMeta) {
    // 只留尾部偏 core 的中间：取前 maxChars
    return input.slice(0, maxChars);
  }
  const sep = "\n---\n";
  const i = input.indexOf(sep);
  if (i < 0) return input.slice(0, maxChars);
  const head = input.slice(0, i + sep.length);
  let window = input.slice(i + sep.length);
  const budget = maxChars - head.length;
  if (budget <= 0) return input.slice(0, maxChars);
  if (window.length > budget) {
    // 保留窗口中段（偏 core）：从两侧对称砍
    const drop = window.length - budget;
    const dropL = Math.floor(drop / 2);
    window = window.slice(dropL, dropL + budget);
  }
  return head + window;
}
