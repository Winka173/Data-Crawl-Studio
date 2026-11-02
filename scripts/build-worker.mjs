// Packages the Node worker as a self-contained sidecar folder for the Tauri bundle:
//   build/sidecar/node.exe        - the Node runtime this repo was built and tested with
//   build/sidecar/worker.cjs      - the bundled worker
//   build/sidecar/node_modules/   - only the native/runtime packages esbuild cannot inline
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'sidecar');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const EXTERNAL = ['better-sqlite3', 'koffi', 'playwright-core'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'worker', 'src', 'main.ts')],
  outfile: path.join(out, 'worker.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: EXTERNAL,
  define: { __DCS_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

fs.copyFileSync(process.execPath, path.join(out, 'node.exe'));

// Copy each external package and its (optional) dependency closure from the root node_modules.
const nm = path.join(root, 'node_modules');
const INSTALL_ONLY = new Set(['prebuild-install']); // install-time helpers never required at runtime
const seen = new Set();
function closure(name) {
  if (seen.has(name) || INSTALL_ONLY.has(name)) return;
  const dir = path.join(nm, name);
  if (!fs.existsSync(dir)) return; // optional dependency for another platform
  seen.add(name);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...(p.dependencies ?? {}), ...(p.optionalDependencies ?? {}) })) closure(dep);
}
EXTERNAL.forEach(closure);

// Per-package pruning: keep what is loaded at runtime, drop sources, debug symbols and docs.
const PRUNE = {
  'better-sqlite3': (rel) =>
    rel === 'package.json' || rel.startsWith('lib' + path.sep) || rel === path.join('build', 'Release', 'better_sqlite3.node'),
};
const DROP = /(^|[\\/])(docs?|test|tests|\.github|CHANGELOG\.md|README\.md)([\\/]|$)|\.(pdb|ipdb|iobj|lib|exp|obj|map|md|ts)$/i;

function copyPkg(name) {
  const src = path.join(nm, name);
  const dst = path.join(out, 'node_modules', name);
  const keep = PRUNE[name];
  for (const file of walk(src)) {
    const rel = path.relative(src, file);
    if (keep ? !keep(rel) : DROP.test(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
    fs.copyFileSync(file, path.join(dst, rel));
  }
}
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
for (const name of seen) copyPkg(name);

fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'dcs-worker', private: true, version: pkg.version, main: 'worker.cjs' }, null, 2),
);

const size = [...walk(out)].reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`sidecar ready: ${out} (${(size / 1048576).toFixed(1)} MB, packages: ${[...seen].join(', ')})`);
