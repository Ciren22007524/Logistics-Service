/** Adapter 必須拋出可區分的錯誤（規格第 6 節），決定是否重試。 */
export abstract class CarrierError extends Error {
  abstract readonly kind: 'RETRYABLE' | 'VALIDATION' | 'AUTH' | 'UNKNOWN';
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 逾時、5xx、限流 → 指數退避重試 */
export class RetryableError extends CarrierError {
  readonly kind = 'RETRYABLE' as const;
}
/** 地址／電話格式錯、品名過長 → 不重試，FAILED，通知上游 */
export class ValidationError extends CarrierError {
  readonly kind = 'VALIDATION' as const;
  constructor(
    message: string,
    public readonly fields: Record<string, string> = {},
    raw?: unknown,
  ) {
    super(message, raw);
  }
}
/** 金鑰錯誤 → 不重試，告警 */
export class AuthError extends CarrierError {
  readonly kind = 'AUTH' as const;
}
/** 無法判斷 → 有限次數重試後 FAILED + 告警 */
export class UnknownError extends CarrierError {
  readonly kind = 'UNKNOWN' as const;
}

export function toCarrierError(err: unknown): CarrierError {
  if (err instanceof CarrierError) return err;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    return new RetryableError(`timeout: ${err.message}`);
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return new RetryableError(err.message);
  return new UnknownError(err instanceof Error ? err.message : String(err));
}

/** HTTP 狀態碼 → 錯誤類型的共用規則 */
export function errorForHttpStatus(status: number, body: string): CarrierError {
  if (status === 401 || status === 403) return new AuthError(`HTTP ${status}`, body);
  if (status === 408 || status === 429 || status >= 500) return new RetryableError(`HTTP ${status}`, body);
  if (status >= 400) return new ValidationError(`HTTP ${status}`, {}, body);
  return new UnknownError(`HTTP ${status}`, body);
}
