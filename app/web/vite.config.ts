import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  // 不做 /api 代理：前端直连后端，走真实 CORS，把跨域配置也一并验证掉。
});
