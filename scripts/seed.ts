/**
 * 本機初始資料：建立一個租戶、API key、MOCK 預設帳號與綠界 C2C 測試帳號。
 * 已有租戶時不重複建立；加 --new-key 可替第一個租戶再發一把 API key。
 */
import { randomToken } from '../src/infra/crypto/secrets.js';
import { closeDb, tx } from '../src/infra/db/pool.js';
import { createApiKey, createCarrierAccount, createTenant, listTenants } from '../src/infra/db/repositories.js';

const sender = { name: '測試寄件人', phone: '0911222333', zip: '330', address: '桃園市桃園區測試路1號' };

try {
  const existing = await listTenants();
  if (existing.length) {
    console.log(`已有 ${existing.length} 個租戶，略過建立。第一個租戶：${existing[0]!.name} (${existing[0]!.id})`);
    if (process.argv.includes('--new-key')) {
      const { key } = await createApiKey(existing[0]!.id, 'seed');
      console.log(`新的 API key：${key}`);
    }
  } else {
    const result = await tx(async (c) => {
      const tenant = await createTenant(
        { name: '預設租戶', webhook_url: null, store_map_return_origins: ['http://localhost:5310'] },
        c,
      );
      const { key } = await createApiKey(tenant.id, 'seed', c);
      const mockId = await createCarrierAccount(
        {
          tenant_id: tenant.id,
          carrier_code: 'MOCK',
          name: '模擬物流',
          credentials: { callbackSecret: randomToken(24) },
          is_sandbox: true,
          is_default: true,
          sender_info: sender,
        },
        c,
      );
      // 綠界物流公開的 C2C 測試帳號（官方文件提供的 stage 值，非機密）
      const ecpayId = await createCarrierAccount(
        {
          tenant_id: tenant.id,
          carrier_code: 'ECPAY_CVS',
          name: '綠界 C2C 測試帳號',
          credentials: { merchantId: '2000933', hashKey: 'XBERn1YOvpM9nfZc', hashIv: 'h1ONHk4P4yqbl5LK', mode: 'C2C' },
          is_sandbox: true,
          is_default: false,
          sender_info: { ...sender, name: '王測試' },
        },
        c,
      );
      return { tenant, key, mockId, ecpayId };
    });
    console.log('建立完成：');
    console.log(`  tenant_id        ${result.tenant.id}`);
    console.log(`  webhook_secret   ${result.tenant.webhook_secret}`);
    console.log(`  API key          ${result.key}   ← 只顯示這一次`);
    console.log(`  MOCK 帳號        ${result.mockId}（預設）`);
    console.log(`  ECPAY_CVS 帳號   ${result.ecpayId}`);
  }
} finally {
  await closeDb();
}
