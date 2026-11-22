#!/usr/bin/env node
/**
 * Gezielte Prüfung für Football Dynasty: Typecheck der betroffenen Workspaces + Vitest „related“.
 *   node .claude/hooks/check.mjs [dateien…]      (ohne Argumente: alle seit letzter Prüfung geänderten Dateien)
 * Exit 0 = ok, 1 = Fehler (gekürzte Ausgabe auf stderr). Keine Playwright-/DB-Tests (zu teuer für jeden Lauf).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STATE = join(ROOT, '.claude/state');
const DIRTY = join(STATE, 'dirty.json');

export function readDirty() { try { return JSON.parse(readFileSync(DIRTY, 'utf8')); } catch { return []; } }
export function writeDirty(list) { mkdirSync(STATE, { recursive: true }); writeFileSync(DIRTY, JSON.stringify([...new Set(list)], null, 0)); }

const WS = [
  { dir: 'apps/web', ws: '@fd/web', vitest: true },
  { dir: 'apps/match-server', ws: '@fd/match-server', vitest: true },
  { dir: 'packages/engine', ws: '@fd/engine', vitest: true },
  { dir: 'packages/shared', ws: '@fd/shared', vitest: true, also: ['apps/web', 'apps/match-server', 'packages/engine'] },
  { dir: 'netlify', tsc: 'netlify/tsconfig.json' },
];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut: r.error?.code === 'ETIMEDOUT' };
}
const trim = (s, n = 40) => s.split('\n').filter((l) => /error|fail|×|✗|FAIL|TS\d{4}|expected|Error/i.test(l)).slice(0, n).join('\n') || s.split('\n').slice(-n).join('\n');

export function check(files) {
  const rel = files.map((f) => relative(ROOT, resolve(ROOT, f)).replace(/\\/g, '/')).filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.includes('node_modules'));
  const results = [];
  if (!rel.length) return { ok: true, results, sqlChanged: files.some((f) => /\.sql$/.test(f)) };
  const touched = new Set();
  for (const w of WS) if (rel.some((f) => f.startsWith(w.dir + '/'))) { touched.add(w.dir); for (const a of w.also ?? []) touched.add(a); }
  for (const w of WS.filter((x) => touched.has(x.dir))) {
    const t = w.tsc ? run('npx', ['tsc', '-p', w.tsc, '--noEmit'], ROOT) : run('npm', ['run', 'typecheck', '-w', w.ws, '--if-present'], ROOT);
    results.push({ name: `typecheck ${w.dir}`, ...t });
    const mine = rel.filter((f) => f.startsWith(w.dir + '/') && !f.includes('/e2e/')).map((f) => f.slice(w.dir.length + 1));
    if (w.vitest && mine.length && existsSync(join(ROOT, w.dir))) {
      const v = run('npx', ['vitest', 'related', '--run', '--passWithNoTests', ...mine], join(ROOT, w.dir));
      results.push({ name: `vitest related ${w.dir}`, ...v });
    }
  }
  return { ok: results.every((r) => r.ok), results, sqlChanged: files.some((f) => /\.sql$/.test(f)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length ? args : readDirty();
  const r = check(files);
  for (const x of r.results) console.log(`${x.ok ? '✓' : '✗'} ${x.name}${x.timedOut ? ' (Zeitlimit)' : ''}`);
  if (r.sqlChanged) console.log('ℹ SQL geändert → bash scripts/test-db.sh ausführen');
  if (!r.ok) { for (const x of r.results.filter((y) => !y.ok)) console.error(`--- ${x.name}\n${trim(x.out)}`); process.exit(1); }
  if (!args.length) writeDirty([]);
}
