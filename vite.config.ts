import { defineConfig } from 'vite';

// 静的ホスティング用。外部CDNやリモートフォントは使わない。
// `--mode artifact` は claude.ai に置く1ファイル版用（画像も埋め込む）。
export default defineConfig(({ mode }) => ({
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: {
    target: 'es2020',
    assetsInlineLimit: mode === 'artifact' ? 100_000_000 : 0,
    outDir: mode === 'artifact' ? 'dist-artifact' : 'dist',
    sourcemap: false,
    modulePreload: false,
  },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
}) as never);
