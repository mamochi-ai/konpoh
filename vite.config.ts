import { defineConfig } from 'vite';

// 静的ホスティング用。外部CDNやリモートフォントは使わない。
export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2020', assetsInlineLimit: 0, sourcemap: false },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
} as never);
