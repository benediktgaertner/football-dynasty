#!/usr/bin/env node
/**
 * PreToolUse-Schutz: Deployments, Pushes und schreibende Zugriffe auf Produktivdaten nur mit ausdrücklicher Freigabe.
 * Gibt „ask“ zurück (Nutzer muss bestätigen); gefährliche Löschbefehle auf Produktion werden abgelehnt.
 */
let raw = '';
const out = (decision, reason) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
};
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  let i = {};
  try { i = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const tool = i.tool_name ?? '';
  const input = i.tool_input ?? {};
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = String(input.command ?? '');
    if (/\b(flyctl|fly)(\.exe)?["']?\s+(deploy|scale|secrets\s+(set|unset)|apps\s+destroy|machine\s+(destroy|stop))/i.test(c)) return out('ask', 'Fly.io-Deployment/Änderung – nur mit ausdrücklicher Freigabe.');
    if (/\bnetlify(\.cmd)?\s+(deploy|env:set|env:unset)/i.test(c)) return out('ask', 'Netlify-Deployment – nur mit ausdrücklicher Freigabe.');
    if (/\bgit\s+push\b/i.test(c)) return out('ask', 'git push löst Netlify-Deploy aus – nur mit Freigabe.');
    if (/\bsupabase\s+(db\s+(push|reset)|migration\s+repair|projects\s+delete|secrets\s+set)/i.test(c)) return out('ask', 'Supabase-Produktivänderung – nur mit Freigabe.');
    if (/(pooler\.supabase\.com|\.supabase\.co)/i.test(c) && /\b(drop|truncate|delete\s+from|update\s+\w+\s+set|alter\s+table|pg_restore)\b/i.test(c)) return out('deny', 'Schreibender SQL-Zugriff auf die Produktivdatenbank ist gesperrt – SQL als Datei an den Nutzer übergeben.');
    return process.exit(0);
  }
  if (/supabase/i.test(tool)) {
    if (/__(apply_migration|deploy_edge_function|create_branch|delete_branch|merge_branch|reset_branch|rebase_branch|pause_project|restore_project|create_project|create_edge_function_secret)$/.test(tool)) return out('ask', 'Supabase-Produktivänderung – nur mit ausdrücklicher Freigabe (sonst SQL-Datei für den Nutzer).');
    if (/__execute_sql$/.test(tool)) {
      const q = String(input.query ?? '').replace(/--.*$/gm, '');
      if (/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|vacuum|reindex|comment\s+on|select\s+.*\bpg_terminate)\b/i.test(q)) return out('ask', 'Schreibendes SQL auf Produktion – nur mit ausdrücklicher Freigabe. Lesend ist erlaubt.');
    }
  }
  process.exit(0);
});
