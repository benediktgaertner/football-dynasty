#!/usr/bin/env node
/**
 * Stop-Hook: kontrollierter Build-Test-Fix-Loop.
 * Wurden Code-Dateien geändert, laufen Typecheck + betroffene Vitest-Tests (check.mjs).
 * Fehler → Claude macht weiter (exit 2, gekürzte Fehlermeldung). Höchstens 3 Korrekturrunden je Sitzung
 * ohne Erfolg; danach wird freigegeben und der Befund in .claude/state/blocked.md dokumentiert
 * (Eskalation an den architect-Agent). Keine rekursiven Agent-Aufrufe, keine Endlosschleife.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, check, readDirty, writeDirty } from './check.mjs';

const MAX = 3;
let raw = '';
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* */ }
  const files = readDirty();
  if (!files.length) process.exit(0);
  mkdirSync(STATE, { recursive: true });
  const loopFile = join(STATE, 'loop.json');
  let loop = { session: input.session_id, attempts: 0 };
  try { const l = JSON.parse(readFileSync(loopFile, 'utf8')); if (l.session === input.session_id) loop = l; } catch { /* */ }

  const r = check(files);
  const summary = r.results.map((x) => `${x.ok ? '✓' : '✗'} ${x.name}`).join('\n');
  if (r.ok) {
    writeDirty([]);
    writeFileSync(loopFile, JSON.stringify({ session: input.session_id, attempts: 0 }));
    const note = r.sqlChanged ? '\nℹ SQL geändert: bash scripts/test-db.sh ausführen (tester).' : '';
    console.log(JSON.stringify({ systemMessage: `Prüfung ok:\n${summary}${note}` }));
    process.exit(0);
  }
  loop.attempts += 1;
  writeFileSync(loopFile, JSON.stringify(loop));
  const errors = r.results.filter((x) => !x.ok).map((x) => `--- ${x.name}\n${x.out.split('\n').filter((l) => /error|fail|×|TS\d{4}|expected|Error/i.test(l)).slice(0, 30).join('\n')}`).join('\n');
  if (loop.attempts > MAX) {
    writeFileSync(join(STATE, 'blocked.md'), `# Blocker (${new Date().toISOString()})\n\nNach ${MAX} Korrekturversuchen weiterhin fehlerhaft:\n\n${summary}\n\n\`\`\`\n${errors}\n\`\`\`\n\nNächster Schritt: architect-Agent zur Analyse einsetzen.\n`);
    writeDirty([]);
    writeFileSync(loopFile, JSON.stringify({ session: input.session_id, attempts: 0 }));
    console.log(JSON.stringify({ systemMessage: `Build-Test-Fix-Loop gestoppt nach ${MAX} Versuchen – Befund in .claude/state/blocked.md (an architect eskalieren).` }));
    process.exit(0);
  }
  process.stderr.write(`Prüfung fehlgeschlagen (Korrekturversuch ${loop.attempts}/${MAX}). Behebe gezielt nur diese Fehler, keine Umbauten:\n${summary}\n${errors}\n`);
  process.exit(2);
});
