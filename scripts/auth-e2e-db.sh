#!/usr/bin/env bash
# Startet eine lokale PostgreSQL-Instanz mit allen Migrationen für die Login-E2E-Tests (apps/web/e2e/auth).
# Bleibt im Hintergrund aktiv; Stopp: pg_ctl -D <Datenordner> stop (Pfad steht in /tmp/fd-auth-e2e.env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${AUTH_PG_PORT:-54361}"
ENVF=/tmp/fd-auth-e2e.env
RUN_AS=()
[ "$(id -u)" = "0" ] && RUN_AS=(sudo -u postgres)
if [ -f "$ENVF" ]; then
  # alte Instanz beenden
  OLD="$(grep '^DATA=' "$ENVF" | cut -d= -f2)"
  [ -n "$OLD" ] && "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$OLD" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$OLD"
fi
DATA="$(mktemp -d /tmp/fd-auth-pg-XXXX)"
[ "$(id -u)" = "0" ] && chown postgres "$DATA"
"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA" -U postgres --locale=C.UTF-8 --encoding=UTF8 >/dev/null 2>&1
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"
run() { psql -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -f "$ROOT/supabase/tests/00_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do run -f "$f" >/dev/null; done
run -f "$ROOT/supabase/tests/01_test_helpers.sql"
# Vereinsdaten wie in 10_lobby_and_security.sql (für bestehende Test-Accounts)
sed -n 5,15p "$ROOT/supabase/tests/10_lobby_and_security.sql" | run
run -c "alter role postgres password 'postgres'"
printf 'DATA=%s\nPORT=%s\n' "$DATA" "$PORT" > "$ENVF"
echo "DB bereit auf Port $PORT"
