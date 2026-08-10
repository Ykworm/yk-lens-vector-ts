/**
 * Lance 时间列统一存「本地时区 RFC3339 秒级定宽字符串」（如 2026-08-10T20:02:13+08:00）：
 * 人类可读，且字典序 = 时间序（btree 标量索引、SQL 范围过滤、browse 排序全部依赖这一点）。
 * 不能用 toISOString()（UTC + 毫秒）或任何裁尾零的变长格式——变长会破坏字典序。
 *
 * 对外 HTTP 契约保持 unix 秒（int64）不变，在存储边界单向转换。
 */

/** unix 秒 → 本地时区 RFC3339 定宽字符串；0 / 非法值 → ""（等同旧 0 的"未知"语义）。 */
export function unixToLocalIso(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const offMin = -d.getTimezoneOffset(); // UTC 偏移（分钟），+08:00 → 480
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

export function nowLocalIso(): string {
  return unixToLocalIso(Math.floor(Date.now() / 1000));
}
