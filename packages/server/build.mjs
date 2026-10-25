// Bundles the server into a single ESM file. Native modules stay external and ship in node_modules.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/opencord-server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', '@node-rs/argon2', 'mediasoup'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  define: { 'process.env.OPENCORD_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
fs.chmodSync('dist/opencord-server.mjs', 0o755);
