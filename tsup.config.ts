import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  // Node 18+, Deno, Bun, and edge runtimes all provide fetch and WebCrypto.
  platform: 'neutral',
  target: 'es2022',
  // tsup's declaration build sets the deprecated `baseUrl` itself; TypeScript 6 rejects it otherwise.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  minify: true,
  // Keep class/function names so errors read ShablonixApiError, not a mangled letter.
  keepNames: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  splitting: false,
});
