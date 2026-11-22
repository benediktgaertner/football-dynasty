#!/usr/bin/env node
// PostToolUse (Edit/Write/MultiEdit/NotebookEdit): geänderte Datei für die Prüfung am Ende vormerken (kostet nichts).
import { readDirty, writeDirty } from './check.mjs';
let raw = '';
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  try {
    const i = JSON.parse(raw || '{}');
    const f = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
    if (f) writeDirty([...readDirty(), f]);
  } catch { /* nie blockieren */ }
  process.exit(0);
});
