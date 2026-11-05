/**
 * Build the TypeScript sources into the exact artifacts the DSH profile loads.
 *
 * `client.js` must be a CJS-shaped bundle wrapped in the browser module
 * loader's factory: React comes from the host module table and the package id
 * is the module id. `index.js` is the Host half (plain ESM).
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'src/client.tsx')],
  outfile: join(root, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { const module = { exports: {} }; const exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})

await build({
  entryPoints: [join(root, 'src/host.ts')],
  outfile: join(root, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  legalComments: 'none',
})

console.log(`built ${pkg.name}: client.js, index.js`)
