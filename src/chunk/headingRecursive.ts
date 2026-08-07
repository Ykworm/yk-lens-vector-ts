/** heading_recursive：MD 标题切 + 过长节 recursive（对齐 yk-vector-go） */

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

export interface Piece {
  text: string;
  chunkIndex: number;
  headingPath: string;
  /** 在 strip 后 body 中的起止偏移 [start, end)，供 Enrich 取邻域 */
  start: number;
  end: number;
}

export function normalizeOptions(opts?: Partial<ChunkOptions>): ChunkOptions {
  return {
    maxTokens: opts?.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 512,
    overlapTokens: opts?.overlapTokens != null && opts.overlapTokens >= 0 ? opts.overlapTokens : 64,
  };
}

/**
 * 切分结果。返回 pieces 与 strip 后的 body（Enrich 取 ± 用同一 body）。
 */
export function splitHeadingRecursive(
  content: string,
  opts?: Partial<ChunkOptions>,
): { body: string; pieces: Piece[] } {
  const o = normalizeOptions(opts);
  let body = stripFrontmatter(content);
  body = body.replace(/\r\n/g, "\n").trim();
  if (!body) return { body: "", pieces: [] };

  const sections = splitByHeadings(body);
  const pieces: Piece[] = [];
  let idx = 0;
  let searchFrom = 0;

  for (const sec of sections) {
    const text = sec.text.trim();
    if (!text) continue;

    let secStart = body.indexOf(text, searchFrom);
    if (secStart < 0) secStart = body.indexOf(text);
    if (secStart < 0) secStart = searchFrom;

    if (estimateTokens(text) <= o.maxTokens) {
      pieces.push({
        text,
        chunkIndex: idx++,
        headingPath: sec.path,
        start: secStart,
        end: secStart + text.length,
      });
      searchFrom = secStart + 1;
      continue;
    }

    let pieceFrom = secStart;
    for (const p of recursiveSplit(text, o.maxTokens, o.overlapTokens)) {
      const t = p.trim();
      if (!t) continue;
      let start = body.indexOf(t, pieceFrom);
      if (start < 0) start = body.indexOf(t, secStart);
      if (start < 0) start = pieceFrom;
      const end = start + t.length;
      pieces.push({
        text: t,
        chunkIndex: idx++,
        headingPath: sec.path,
        start,
        end,
      });
      // 允许 overlap：下次从 start+1 找
      pieceFrom = start + 1;
    }
    searchFrom = secStart + Math.max(1, text.length);
  }
  return { body, pieces };
}

interface Section {
  path: string;
  text: string;
}

const headingLine = /^(#{1,6})\s+(.+?)\s*$/;

function splitByHeadings(body: string): Section[] {
  const lines = body.split("\n");
  const out: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buf: string[] = [];
  let curPath = "(intro)";
  let started = false;

  const flush = () => {
    const t = buf.join("\n").trim();
    if (!t && !started) {
      buf = [];
      return;
    }
    if (t) out.push({ path: curPath, text: t });
    buf = [];
    started = true;
  };

  for (const line of lines) {
    const m = line.match(headingLine);
    if (!m) {
      buf.push(line);
      continue;
    }
    flush();
    const level = m[1].length;
    const title = m[2].trim();
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    curPath = joinHeadingPath(stack);
    buf.push(line);
  }
  flush();
  if (out.length === 0) return [{ path: "(intro)", text: body }];
  return out;
}

function joinHeadingPath(stack: { level: number; title: string }[]): string {
  if (stack.length === 0) return "(intro)";
  return stack.map((h) => "#".repeat(h.level) + " " + h.title).join("/");
}

function stripFrontmatter(s: string): string {
  s = s.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("---")) return s;
  const lines = s.split("\n");
  if (lines.length < 2 || lines[0].trim() !== "---") return s;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n").trim();
    }
  }
  return s;
}

function recursiveSplit(text: string, maxTokens: number, overlap: number, depth = 0): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  // 防死递归：过深或无法再切时硬切
  if (depth > 32) return hardSplitRunes(text, maxTokens, overlap);

  const seps = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", "; ", " "];
  for (const sep of seps) {
    const parts = splitKeepingSep(text, sep);
    if (parts.length <= 1) continue;
    const merged = mergeParts(parts, maxTokens, overlap);
    // 若合并后仍整块超限且未真正切开，换更细分隔符
    if (merged.length === 1 && estimateTokens(merged[0]) > maxTokens) continue;

    const out: string[] = [];
    for (const m of merged) {
      if (estimateTokens(m) <= maxTokens) out.push(m);
      else out.push(...recursiveSplit(m, maxTokens, overlap, depth + 1));
    }
    // 必须有进展（块数增加或总长下降），否则硬切
    if (out.length > 1 || (out.length === 1 && estimateTokens(out[0]) <= maxTokens)) {
      return out;
    }
  }
  return hardSplitRunes(text, maxTokens, overlap);
}

function splitKeepingSep(text: string, sep: string): string[] {
  if (sep === "") return [text];
  if (sep === "\n\n" || sep === "\n") return splitOutsideFences(text, sep);
  return text.split(sep);
}

function splitOutsideFences(text: string, sep: string): string[] {
  const lines = text.split("\n");
  const parts: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (buf.length === 0) return;
    parts.push(buf.join("\n"));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();
    if (trim.startsWith("```")) inFence = !inFence;
    if (i > 0) {
      if (!inFence && sep === "\n") {
        flush();
      } else if (!inFence && sep === "\n\n") {
        if (line === "") {
          flush();
          continue;
        }
      }
    }
    buf.push(line);
  }
  flush();
  return parts.length === 0 ? [text] : parts;
}

function mergeParts(parts: string[], maxTokens: number, overlap: number): string[] {
  if (parts.length === 0) return [];
  const out: string[] = [];
  let cur = "";
  let curTok = 0;
  const flush = () => {
    if (!cur) return;
    out.push(cur);
    if (overlap > 0) {
      const tail = takeTailByTokens(cur, overlap);
      cur = tail;
      curTok = estimateTokens(tail);
    } else {
      cur = "";
      curTok = 0;
    }
  };
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const pt = estimateTokens(p);
    if (curTok > 0 && curTok + pt > maxTokens) flush();
    if (cur && !cur.endsWith("\n") && !p.startsWith("\n")) {
      cur += "\n";
      curTok++;
    }
    cur += p;
    curTok = estimateTokens(cur);
    if (curTok > maxTokens && cur.trim() === p) {
      out.push(cur);
      cur = "";
      curTok = 0;
    }
  }
  if (cur.trim()) {
    if (out.length === 0 || out[out.length - 1] !== cur) out.push(cur);
  }
  return out;
}

function takeTailByTokens(s: string, tokens: number): string {
  if (tokens <= 0) return "";
  const r = [...s];
  if (r.length === 0) return "";
  for (let i = r.length - 1; i >= 0; i--) {
    if (estimateTokens(r.slice(i).join("")) >= tokens) return r.slice(i).join("");
  }
  return s;
}

function hardSplitRunes(text: string, maxTokens: number, overlap: number): string[] {
  if (!text) return [];
  const r = [...text];
  const out: string[] = [];
  let start = 0;
  while (start < r.length) {
    let end = start;
    while (end < r.length && estimateTokens(r.slice(start, end + 1).join("")) <= maxTokens) end++;
    if (end === start) end = start + 1;
    out.push(r.slice(start, end).join(""));
    if (end >= r.length) break;
    let next = end;
    if (overlap > 0) {
      const tail = takeTailByTokens(r.slice(start, end).join(""), overlap);
      const back = [...tail].length;
      next = end - back;
      if (next < 0) next = 0;
    }
    // 保证前进，避免 overlap 导致死循环
    if (next <= start) next = end;
    start = next;
  }
  return out;
}

/** 粗估 token：CJK≈1，其它≈4 字 1 token */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isCJK(cp)) cjk++;
    else if (!/\s/.test(ch)) other++;
  }
  const spaces = (s.match(/ /g) || []).length + (s.match(/\n/g) || []).length;
  let n = cjk + Math.floor((other + 3) / 4) + Math.floor((spaces + 7) / 8);
  if (n < 1) n = 1;
  return n;
}

function isCJK(r: number): boolean {
  return (
    (r >= 0x4e00 && r <= 0x9fff) ||
    (r >= 0x3400 && r <= 0x4dbf) ||
    (r >= 0x3040 && r <= 0x30ff) ||
    (r >= 0xac00 && r <= 0xd7af) ||
    (r >= 0xf900 && r <= 0xfaff)
  );
}
