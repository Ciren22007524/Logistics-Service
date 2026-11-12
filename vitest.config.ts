import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // 整合測試共用同一個資料庫，避免並行互相干擾
    fileParallelism: false,
    env: { LOG_LEVEL: 'silent' },
  },
});
