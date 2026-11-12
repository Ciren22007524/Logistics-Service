import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 物流商金鑰應用層加密：AES-256-GCM。
 * 格式：[1 byte 版本=2][4 bytes 金鑰指紋][12 bytes IV][16 bytes tag][ciphertext]
 * 金鑰指紋 = sha256(key) 前 4 bytes。輪替：把新金鑰放在 CREDENTIALS_ENC_KEYS 第一把，
 * 舊金鑰留在後面繼續解密，跑 reencrypt 之後再移除舊金鑰。
 */
export class SecretBox {
  private readonly keys: { key: Buffer; fp: Buffer }[];

  constructor(keysCsv: string) {
    this.keys = keysCsv
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => {
        const key = Buffer.from(k, 'base64');
        if (key.length !== 32) throw new Error('CREDENTIALS_ENC_KEYS 每把都必須是 base64 編碼的 32 bytes');
        return { key, fp: createHash('sha256').update(key).digest().subarray(0, 4) };
      });
    if (this.keys.length === 0) throw new Error('CREDENTIALS_ENC_KEYS 未設定');
  }

  encrypt(plaintext: string): Buffer {
    const { key, fp } = this.keys[0]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([2]), fp, iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer): string {
    if (blob[0] !== 2) throw new Error('unsupported secret version');
    const fp = blob.subarray(1, 5);
    const entry = this.keys.find((k) => k.fp.equals(fp));
    if (!entry) throw new Error('secret encrypted with a key that is not configured');
    const decipher = createDecipheriv('aes-256-gcm', entry.key, blob.subarray(5, 17));
    decipher.setAuthTag(blob.subarray(17, 33));
    return Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]).toString('utf8');
  }

  /** 是否已用目前的主金鑰加密 */
  isCurrent(blob: Buffer): boolean {
    return blob[0] === 2 && blob.subarray(1, 5).equals(this.keys[0]!.fp);
  }

  /** 用目前的主金鑰重新加密（輪替時用） */
  reencrypt(blob: Buffer): Buffer {
    return this.encrypt(this.decrypt(blob));
  }
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export const hmacSha256 = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
