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
check() { # check <name> <psql-args…>
  local name="$1"; shift
  if out="$(run "$@" 2>&1)"; then
    checks="$(grep -c 'NOTICE:  ok:' <<<"$out" || true)"
    echo "✓ $name: $checks Prüfungen bestanden"
  else
    echo "✗ $name"
    grep -E 'ERROR|FEHLGESCHLAGEN' <<<"$out" | head -20
    status=1
  fi
}

for t in "$ROOT"/supabase/tests/1*.sql "$PARITY"; do
  check "$(basename "$t")" -f "$t"
done
rm -f "$PARITY"

# ---------------- Phase 3: Draft ----------------
run -f "$ROOT/supabase/tests/20_draft_setup.sql" >/dev/null
WORLD="$(run -tAc "select id from public.career_worlds where name = 'Draftwelt'")"
SEED="$(run -tAc "select seed from public.career_worlds where id = '$WORLD'")"
HUMANS="$(run -tAc "select json_agg(json_build_object('id', id, 'name', name, 'short_name', short_name)) from public.clubs where world_id = '$WORLD' and control = 'human'")"
PDIR="$(mktemp -d /tmp/fd-payload-XXXX)"
chmod 755 "$PDIR"
node "$ROOT/scripts/build-world-payload.mjs" "$SEED" "$HUMANS" >"$PDIR/payload.json"
node "$ROOT/scripts/build-world-payload.mjs" "$SEED" "$HUMANS" --mutate=pool399 >"$PDIR/pool399.json"
node "$ROOT/scripts/build-world-payload.mjs" "$SEED" "$HUMANS" --mutate=pool84 >"$PDIR/pool84.json"
node "$ROOT/scripts/build-world-payload.mjs" "$SEED" "$HUMANS" --mutate=badcrest >"$PDIR/badcrest.json"
check "21_draft.sql" -v world="$WORLD" -v dir="$PDIR" -f "$ROOT/supabase/tests/21_draft.sql"

# N2/A3: Zwei gleichzeitige Verbindungen versuchen denselben Spieler zu verpflichten
CUR_USER="$(run -tAc "select c.manager_user_id from public.draft_sessions d join public.clubs c on c.id = d.club_order[public.fd_snake_index(cardinality(d.club_order), d.current_pick) + 1] where d.world_id = '$WORLD'")"
OTHER_USER="$(run -tAc "select manager_user_id from public.clubs where world_id = '$WORLD' and control = 'human' and manager_user_id <> '$CUR_USER'")"
TARGET="$(run -tAc "select id from public.players where world_id = '$WORLD' and in_draft_pool order by overall desc limit 1")"
PICKS_BEFORE="$(run -tAc "select count(*) from public.draft_picks where world_id = '$WORLD'")"
pick_as() { run -tAc "set role authenticated; select tests.login('$1'); select public.make_draft_pick('$WORLD', '$TARGET');" >"$2" 2>&1 || true; }
for i in 1 2 3; do pick_as "$CUR_USER" "$PDIR/c$i.out" & done
pick_as "$OTHER_USER" "$PDIR/o.out" &
wait
OWNERS="$(run -tAc "select count(*) from public.draft_picks where player_id = '$TARGET'")"
PICKS_AFTER="$(run -tAc "select count(*) from public.draft_picks where world_id = '$WORLD'")"
OK_CALLS="$(grep -l '"pick_index"' "$PDIR"/c*.out "$PDIR"/o.out | wc -l)"
if [ "$OWNERS" = "1" ] && [ "$OK_CALLS" = "1" ] && [ "$((PICKS_AFTER - PICKS_BEFORE))" = "1" ]; then
  echo "✓ Paralleltest: 4 gleichzeitige Pick-Versuche auf denselben Spieler → genau 1 Pick"
else
  echo "✗ Paralleltest: owners=$OWNERS ok_calls=$OK_CALLS neue_picks=$((PICKS_AFTER - PICKS_BEFORE))"
  cat "$PDIR"/*.out
  status=1
fi

check "22_draft_complete.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/22_draft_complete.sql"
check "30_team.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/30_team.sql"
check "40_matches.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/40_matches.sql"

# Ende-zu-Ende: echtes Setup aus der DB → Match Engine (Server-Adapter) → admin_finish_match
HOST_USER="00000000-0000-0000-0000-0000000000a1"
AI_CLUB="$(run -tAc "select id from public.clubs where world_id = '$WORLD' and control = 'ai' order by name offset 1 limit 1")"
FX="$(run -tAc "set role authenticated; select tests.login('$HOST_USER'); select public.create_friendly('$WORLD', '$AI_CLUB');" | tail -1)"
run -tAc "set role service_role; select public.admin_match_setup('$FX');" | tail -1 >"$PDIR/setup.json"
if node "$ROOT/apps/match-server/dist/simulateFromSetup.js" "$PDIR/setup.json" >"$PDIR/result.json" 2>"$PDIR/sim.err"; then
  RESULT_SQL="$(sed "s/'/''/g" "$PDIR/result.json")"
  SAVED="$(run -tAc "set role service_role; select public.admin_finish_match('$FX', '$RESULT_SQL'::jsonb) ->> 'status';" | tail -1)"
  ROWS="$(run -tAc "select count(*) from public.match_player_stats where fixture_id = '$FX'")"
  MAXSEC="$(run -tAc "select coalesce(max(match_second), 0) from public.match_events where fixture_id = '$FX'")"
  if [ "$SAVED" = "saved" ] && [ "$ROWS" -ge 22 ] && [ "$MAXSEC" -le 5700 ]; then
    echo "✓ Ende-zu-Ende: DB-Setup → Engine → Ergebnis gespeichert ($ROWS Spielerstatistiken, letzte Ereignissekunde $MAXSEC)"
  else
    echo "✗ Ende-zu-Ende: status=$SAVED rows=$ROWS maxsec=$MAXSEC"; status=1
  fi
else
  echo "✗ Ende-zu-Ende: Simulation fehlgeschlagen"; cat "$PDIR/sim.err"; status=1
fi
check "50_season.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/50_season.sql"

# Europaweiter Transfermarkt: Payloads wie die Netlify-Function erzeugen
EXISTING="$(run -tAc "select json_agg(json_build_object('name', name, 'short_name', short_name)) from public.clubs where world_id = '$WORLD'")"
node "$ROOT/scripts/build-europe-payload.mjs" "$SEED" "$EXISTING" "$PDIR" ENG ITA SMR
# Konflikttest: ein unabhängig erzeugter Payload (veraltete Namensliste) darf keine Fehler auslösen
node "$ROOT/scripts/build-europe-payload.mjs" "$SEED" "$EXISTING" "$PDIR/stale" POR
check "60_europe.sql" -v world="$WORLD" -v dir="$PDIR" -f "$ROOT/supabase/tests/60_europe.sql"
check "70_finance.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/70_finance.sql"
check "80_availability.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/80_availability.sql"
check "90_dashboard.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/90_dashboard.sql"
check "95_stadium.sql" -v world="$WORLD" -f "$ROOT/supabase/tests/95_stadium.sql"

# Optional (FULL_EUROPE=1): alle Verbände anlegen und Suchzeiten des Transfermarkts messen
if [ "${FULL_EUROPE:-0}" = "1" ]; then
  EXISTING="$(run -tAc "select json_agg(json_build_object('name', name, 'short_name', short_name)) from public.clubs where world_id = '$WORLD'")"
  CODES="$(node -e "import('$ROOT/packages/shared/dist/index.js').then(m => console.log(m.EUROPE_ASSOCIATIONS.map(a => a.code).filter(c => !['ENG','ITA','SMR','POR'].includes(c)).join(' ')))")"
  node "$ROOT/scripts/build-europe-payload.mjs" "$SEED" "$EXISTING" "$PDIR/full" $CODES
  T0=$(date +%s%N)
  for c in $CODES; do run -tAc "select public.admin_add_europe('$WORLD', pg_read_file('$PDIR/full/$c.json')::jsonb) ->> 'status';" >/dev/null; done
  T1=$(date +%s%N)
  chmod -R 755 "$PDIR"
  echo "Europa komplett: $(run -tAc "select count(*) from public.clubs where world_id = '$WORLD'") Vereine, $(run -tAc "select count(*) from public.players where world_id = '$WORLD'") Spieler, Aufbau $(( (T1 - T0) / 1000000 )) ms"
  run -tAc "analyze;" >/dev/null
  for f in '{}' '{"country":"ESP","min_overall":70}' '{"position":"ST","min_age":20,"max_age":25,"sort":"value"}' '{"search":"son"}' '{"league":"GER1"}' '{"free_agents":true}'; do
    MS="$(run -tA -c '\timing on' -c "set role authenticated" -c "select tests.login('00000000-0000-0000-0000-0000000000a1')" \
      -c "select (public.transfer_market_search('$WORLD', '$f'::jsonb, 50, 0) ->> 'total')" 2>&1 | grep -o 'Time: [0-9.]* ms' | tail -1)"
    TOTAL="$(run -tA -c "set role authenticated" -c "select tests.login('00000000-0000-0000-0000-0000000000a1')" -c "select (public.transfer_market_search('$WORLD', '$f'::jsonb, 50, 0) ->> 'total')" | tail -1)"
    echo "  Suche $f → $TOTAL Treffer, $MS"
  done
  MS="$(run -tA -c '\timing on' -c "set role authenticated" -c "select tests.login('00000000-0000-0000-0000-0000000000a1')" -c "select length(public.transfer_market_options('$WORLD')::text)" 2>&1 | grep -o 'Time: [0-9.]* ms' | tail -1)"
  echo "  Filteroptionen → $MS"
  # Saisonstart-Pfad: Amateurvereine neu anlegen (lief vor dem Hotfix in das Zeitlimit)
  run -tAc "update public.clubs set amateur = false, association_code = 'AUT', name = name || ' Alt', short_name = 'Z' || right(short_name, 3) where world_id = '$WORLD' and amateur" >/dev/null
  OUT="$(run -tA -c '\timing on' -c "select public.fd_ensure_amateurs('$WORLD')" 2>&1 || true)"
  grep -i 'error' <<<"$OUT" || true
  MS="$(grep -o 'Time: [0-9.]* ms' <<<"$OUT" | tail -1)"
  echo "  Amateurvereine anlegen (Saisonstart) → $MS, neu: $(run -tAc "select count(*) from public.clubs where world_id = '$WORLD' and amateur") Vereine mit $(run -tAc "select count(*) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = '$WORLD' and c.amateur") Spielern"
fi
rm -rf "$PDIR"
exit $status
