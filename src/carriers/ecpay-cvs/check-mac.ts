import { createHash } from 'node:crypto';

/**
 * 綠界 CheckMacValue（物流使用 MD5）。
 * 1. 移除 CheckMacValue，參數依名稱（不分大小寫）A→Z 排序
 * 2. 前加 HashKey=…&、後加 &HashIV=…
 * 3. 以 .NET HttpUtility.UrlEncode 規則編碼後轉小寫
 * 4. MD5 → 大寫
 */
export function ecpayUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7e')
    .replace(/'/g, '%27')
    .toLowerCase();
}

export function checkMacValue(params: Record<string, string>, hashKey: string, hashIv: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  const raw = [`HashKey=${hashKey}`, ...keys.map((k) => `${k}=${params[k] ?? ''}`), `HashIV=${hashIv}`].join('&');
  return createHash('md5').update(ecpayUrlEncode(raw)).digest('hex').toUpperCase();
}

export function verifyCheckMacValue(params: Record<string, string>, hashKey: string, hashIv: string): boolean {
  const given = params.CheckMacValue;
  if (!given) return false;
  return checkMacValue(params, hashKey, hashIv) === given.toUpperCase();
}
