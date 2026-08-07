/** 从 Markdown 抽取附图（C-9） */

export interface ImageRef {
  index: number;
  uri: string;
  alt: string;
  bytes?: Buffer;
  mime?: string;
}

const mdImage = /!\[([^\]]*)\]\(([^)]+)\)/g;
const htmlImage = /<img[^>]+src=["']([^"']+)["']/gi;

export function extractImages(md: string, max = 32): ImageRef[] {
  if (max <= 0) max = 32;
  const seen = new Set<string>();
  const out: ImageRef[] = [];

  const add = (uri: string, alt: string) => {
    uri = uri.trim();
    if (!uri || seen.has(uri) || uri.startsWith("#")) return;
    seen.add(uri);
    const ref: ImageRef = { index: out.length, uri, alt: alt.trim() };
    if (uri.startsWith("data:image/")) {
      try {
        const d = decodeDataURL(uri);
        ref.bytes = d.bytes;
        ref.mime = d.mime;
      } catch {
        /* ignore */
      }
    }
    out.push(ref);
  };

  for (const m of md.matchAll(mdImage)) {
    if (out.length >= max) break;
    add(m[2], m[1]);
  }
  for (const m of md.matchAll(htmlImage)) {
    if (out.length >= max) break;
    add(m[1], "");
  }
  return out;
}

export async function fetchImage(ref: ImageRef, maxBytes = 8 << 20): Promise<ImageRef> {
  if (ref.bytes?.length) return ref;
  const uri = ref.uri;
  if (uri.startsWith("data:")) {
    const d = decodeDataURL(uri);
    return { ...ref, bytes: d.bytes, mime: d.mime };
  }
  if (!uri.startsWith("http://") && !uri.startsWith("https://")) {
    throw new Error(`相对路径图需调用方提供字节: ${uri}`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(uri, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`fetch image HTTP ${resp.status}`);
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`image 超过 ${maxBytes} bytes`);
    const bytes = Buffer.from(ab);
    let mime = resp.headers.get("content-type") || sniffMIME(bytes);
    return { ...ref, bytes, mime };
  } finally {
    clearTimeout(t);
  }
}

function decodeDataURL(s: string): { bytes: Buffer; mime: string } {
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

function sniffMIME(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b.length >= 6 && (b.subarray(0, 6).toString() === "GIF87a" || b.subarray(0, 6).toString() === "GIF89a"))
    return "image/gif";
  if (b.length >= 12 && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}
