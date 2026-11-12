import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/infra/crypto/secrets.js';
import { maskAddress, maskName, maskPhone } from '../../src/lib/logger.js';
import { formatTaipei, parseTaipeiTime, toTaipeiIso } from '../../src/lib/time.js';

describe('SecretBox (AES-256-GCM)', () => {
  const k1 = randomBytes(32).toString('base64');
  const k2 = randomBytes(32).toString('base64');

  it('round-trips and is non-deterministic', () => {
    const box = new SecretBox(k1);
    const a = box.encrypt('{"hashKey":"x"}');
    expect(box.decrypt(a)).toBe('{"hashKey":"x"}');
    expect(box.encrypt('same').equals(box.encrypt('same'))).toBe(false);
  });

  it('detects tampering', () => {
    const box = new SecretBox(k1);
    const blob = box.encrypt('secret');
    blob[blob.length - 1]! ^= 1;
    expect(() => box.decrypt(blob)).toThrow();
  });

  it('supports rotation: new primary key first, old key still decrypts', () => {
    const old = new SecretBox(k1).encrypt('v');
    const rotated = new SecretBox(`${k2},${k1}`);
    expect(rotated.decrypt(old)).toBe('v');
    expect(rotated.isCurrent(old)).toBe(false);
    const re = rotated.reencrypt(old);
    expect(rotated.isCurrent(re)).toBe(true);
    expect(new SecretBox(k2).decrypt(re)).toBe('v');
    expect(() => new SecretBox(k1).decrypt(re)).toThrow();
  });

  it('rejects bad keys', () => {
    expect(() => new SecretBox('short')).toThrow();
  });
});

describe('time helpers', () => {
  it('outputs +08:00', () => {
    expect(toTaipeiIso(new Date('2026-11-12T02:00:00Z'))).toBe('2026-11-12T10:00:00+08:00');
  });
  it('parses naive Taiwan time', () => {
    expect(parseTaipeiTime('2026/11/12 10:00:00').toISOString()).toBe('2026-11-12T02:00:00.000Z');
    expect(parseTaipeiTime('2026-11-12T10:00:00+08:00').toISOString()).toBe('2026-11-12T02:00:00.000Z');
  });
  it('formats for carriers', () => {
    expect(formatTaipei(new Date('2026-11-12T02:03:04Z'))).toBe('2026/11/12 10:03:04');
  });
});

describe('PII masking', () => {
  it('masks', () => {
    expect(maskName('王小明')).toBe('王*明');
    expect(maskPhone('0912345678')).toBe('0912***678');
    expect(maskAddress('桃園市桃園區某某路1號')).toBe('桃園市桃園區***');
  });
});
