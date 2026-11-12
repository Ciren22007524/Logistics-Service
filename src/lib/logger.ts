import pino from 'pino';

/** 個資與機密一律遮罩（規格 9.3） */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.recipient',
  '*.recipient.*',
  'recipient',
  '*.credentials',
  'credentials',
  '*.webhook_secret',
  '*.password',
  '*.HashKey',
  '*.HashIV',
];

export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    level,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base: { service: 'logistics-service' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger();
export type Logger = pino.Logger;

export function maskName(name?: string | null): string {
  if (!name) return '';
  const chars = [...name];
  if (chars.length <= 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  return phone.length <= 4 ? '****' : `${phone.slice(0, 4)}***${phone.slice(-3)}`;
}

export function maskAddress(addr?: string | null): string {
  if (!addr) return '';
  return addr.length <= 6 ? `${addr.slice(0, 2)}***` : `${addr.slice(0, 6)}***`;
}
