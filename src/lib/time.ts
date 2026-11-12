/** API 一律輸出 +08:00（規格 9.4）。 */
export function toTaipeiIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

/**
 * 物流商常回傳不帶時區的台灣時間，例如 "2026/11/12 10:00:00"、"2026-11-12 10:00"。
 * 已帶時區（Z 或 ±hh:mm）則照原樣解析。
 */
export function parseTaipeiTime(s: string): Date {
  const trimmed = s.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) return new Date(trimmed);
  const m = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`無法解析時間：${s}`);
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h - 8, +mi, +sec));
}

/** 格式化成台灣時間 "yyyy/MM/dd HH:mm:ss"（ECPay 等物流商要求的格式） */
export function formatTaipei(d: Date, sep = '/'): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${sep}${p(t.getUTCMonth() + 1)}${sep}${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
