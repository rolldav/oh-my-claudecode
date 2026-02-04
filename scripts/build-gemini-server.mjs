#!/usr/bin/env node
/**
 * Build script for Gemini MCP server bundle
 */

import * as esbuild from 'esbuild';
import { mkdir } from 'fs/promises';

const outfile = 'bridge/gemini-server.cjs';

await mkdir('bridge', { recursive: true });

await esbuild.build({
  entryPoints: ['src/mcp/gemini-server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile,
  banner: { js: '#!/usr/bin/env node\n' },
  external: [
    'fs', 'path', 'os', 'util', 'stream', 'events',
    'buffer', 'crypto', 'http', 'https', 'url',
    'child_process', 'assert', 'module', 'net', 'tls',
    'dns', 'readline', 'tty', 'worker_threads',
  ],
});

console.log(`Built ${outfile}`);
