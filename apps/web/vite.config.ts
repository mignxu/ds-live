import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 前端只依赖 contracts（唯一协议源）与纯 UI，不 import server 或任何密钥模块。
 * contracts 直接指向源码，开发时无需先构建契约包。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@dafeiyu/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
      '/health': { target: 'http://127.0.0.1:8787' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
