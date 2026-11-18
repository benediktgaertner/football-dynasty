#!/usr/bin/env bash
# Spielt alle Migrationen in eine frische lokale PostgreSQL-Instanz ein und führt die
# Datenbanktests aus. Benötigt PostgreSQL ≥ 15 (PG_BIN zeigt auf das bin-Verzeichnis)
# und einen gebauten @fd/shared (für die TS/SQL-Paritätstests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PG_TEST_PORT:-54329}"
DATA="$(mktemp -d /tmp/fd-pg-XXXX)"
LOG="$(mktemp /tmp/fd-pg-log-XXXX)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  RUN_AS=(sudo -u postgres)
  chown postgres "$DATA"
fi

cleanup() {
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA" -U postgres --locale=C.UTF-8 --encoding=UTF8 >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=''" -l "$DATA/server.log" -w start >/dev/null

run() {
  psql -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

run -f "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  run -f "$f" >>"$LOG" 2>&1 || { echo "FEHLER in Migration $(basename "$f")"; cat "$LOG"; exit 1; }
  echo "✓ Migration $(basename "$f")"
done
run -f "$ROOT/supabase/tests/01_test_helpers.sql"

PARITY="$(mktemp /tmp/fd-parity-XXXX.sql)"
node "$ROOT/scripts/gen-parity-sql.mjs" >"$PARITY"

status=0
for t in "$ROOT"/supabase/tests/1*.sql "$PARITY"; do
  if out="$(run -f "$t" 2>&1)"; then
    checks="$(grep -c 'NOTICE:  ok:' <<<"$out" || true)"
    echo "✓ $(basename "$t"): $checks Prüfungen bestanden"
  else
    echo "✗ $(basename "$t")"
    grep -E 'ERROR|FEHLGESCHLAGEN' <<<"$out" | head -20
    status=1
  fi
done
rm -f "$PARITY"
exit $status
