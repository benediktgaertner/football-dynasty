-- Testhelfer (nur Testdatenbank)
grant all on all tables in schema public to service_role;

create schema tests;
grant usage on schema tests to authenticated, anon, service_role;

create function tests.login(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false);
end $$;

create function tests.assert(p_condition boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_condition is distinct from true then
    raise exception 'TEST FEHLGESCHLAGEN: %', p_label;
  end if;
  raise notice 'ok: %', p_label;
end $$;

-- Führt SQL aus und erwartet einen Fehler mit passendem Hint (oder Textausschnitt der Meldung).
create function tests.expect_error(p_sql text, p_expected text) returns void
language plpgsql as $$
declare
  v_hint text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
    if coalesce(v_hint, '') <> p_expected and position(p_expected in v_msg) = 0 then
      raise exception 'TEST FEHLGESCHLAGEN: erwartet [%], erhalten: % (hint=%)', p_expected, v_msg, v_hint;
    end if;
    raise notice 'ok: Fehler % (%)', p_expected, v_msg;
    return;
  end;
  raise exception 'TEST FEHLGESCHLAGEN: erwartet Fehler [%], aber die Anweisung lief durch: %', p_expected, p_sql;
end $$;

grant execute on all functions in schema tests to authenticated, anon, service_role;
