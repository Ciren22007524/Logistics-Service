/**
 * 金鑰輪替：CREDENTIALS_ENC_KEYS 第一把放新金鑰、舊金鑰留在後面，執行本腳本把所有物流商帳號重新加密。
 * 完成後才能把舊金鑰從設定移除。
 */
import { secretBox } from '../src/infra/crypto/box.js';
import { closeDb, db } from '../src/infra/db/pool.js';

try {
  const rows = (await db().query<{ id: string; credentials_enc: Buffer }>('SELECT id, credentials_enc FROM carrier_accounts')).rows;
  let n = 0;
  for (const r of rows) {
    if (secretBox().isCurrent(r.credentials_enc)) continue;
    await db().query('UPDATE carrier_accounts SET credentials_enc = $2 WHERE id = $1', [r.id, secretBox().reencrypt(r.credentials_enc)]);
    n++;
  }
  console.log(`re-encrypted ${n}/${rows.length} carrier accounts`);
} finally {
  await closeDb();
}
