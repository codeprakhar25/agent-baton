import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  shims: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Bundle runtime deps so the published package is self-contained
  // (chalk, commander, @inquirer/prompts — all pure JS)
  noExternal: ['chalk', 'commander', '@inquirer/prompts'],
});
