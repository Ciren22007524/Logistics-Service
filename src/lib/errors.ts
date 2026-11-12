/** API 層錯誤：會轉成 { error: { code, message, details } } */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'invalid_request', message, details);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);

/** zod 錯誤 → { 'recipient.phone': '訊息' } */
export function zodDetails(err: { issues: { path: (string | number)[]; message: string }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const k = i.path.join('.') || '_';
    out[k] ??= i.message;
  }
  return out;
}
