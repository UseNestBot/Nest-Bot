import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = { '@shared': resolve('src/shared') };

/** Commit count of HEAD: the build number in "v0.1.0:123". CI passes NEST_BUILD (shallow clones count wrong). */
function buildNumber(): number {
  const fromEnv = Number(process.env.NEST_BUILD);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
// Beta: `npm run dev`, NEST_CHANNEL=beta/nightly, or a prerelease package version (0.2.0-beta.1).
// NEST_CHANNEL=stable forces stable, e.g. to see the plain header in dev.
function channel(dev: boolean): 'beta' | 'stable' {
  const env = process.env.NEST_CHANNEL;
  if (env === 'stable') return 'stable';
  return dev || env === 'beta' || env === 'nightly' || pkg.version.includes('-') ? 'beta' : 'stable';
}

export default defineConfig(({ command }) => {
  const define = {
    __NEST_VERSION__: JSON.stringify(pkg.version),
    __NEST_BUILD__: JSON.stringify(buildNumber()),
    __NEST_CHANNEL__: JSON.stringify(channel(command === 'serve')),
  };
  return {
    main: {
      define,
      resolve: { alias: shared },
      build: {
        rollupOptions: {
          external: ['node:sqlite'],
          // nest-mcp.js is launched by Codex / Claude Code as a stdio MCP server.
          input: { index: resolve('src/main/index.ts'), 'nest-mcp': resolve('src/main/mcp/server.ts') },
          // .mjs so Node treats it as ESM without reading package.json, which Codex's
          // Windows sandbox may not let the server read.
          output: { entryFileNames: (chunk) => (chunk.name === 'nest-mcp' ? '[name].mjs' : '[name].js') },
        },
      },
    },
    preload: {
      define,
      resolve: { alias: shared },
      build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
    },
    renderer: {
      define,
      resolve: { alias: shared },
      plugins: [react(), tailwindcss()],
      // The dictation worker (transformers.js + ONNX Runtime) uses dynamic imports.
      worker: { format: 'es' },
    },
  };
});
