import { readableTextColor } from '@fd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type ClubRef, type MatchdayState, type SlotFixture } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';

const STATUS: Record<string, string> = { scheduled: 'Anstoß offen', live: 'Läuft', finished: 'Beendet', released: 'Beendet' };
const fmtDate = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

/** B4: Spieltags-Zentrale – Vorbereitung, Bereitschaft, Live/Überspringen, gemeinsame Freigabe */
export function Matchday() {
  const { worldId = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<MatchdayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResults, setLastResults] = useState<SlotFixture[] | null>(null);
  const prevSlot = useRef<string | null>(null);

  // Neuladen bündeln: Während der Server viele KI-Spiele abschließt, kommen dutzende Realtime-Ereignisse
  // in kurzer Zeit. Höchstens eine Anfrage gleichzeitig, weitere Auslöser werden zusammengefasst.
  const loading = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(async () => {
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      const s = await seasonApi.matchday(worldId);
      prevSlot.current = s.slot?.id ?? null;
      setState(s);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally {
      loading.current = false;
      if (again.current) { again.current = false; clearTimeout(timer.current); timer.current = setTimeout(() => void load(), 800); }
    }
  }, [worldId]);
  const reload = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    void load();
    const sb = requireSupabase();
    const ch = sb.channel(`md:${worldId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fixtures', filter: `world_id=eq.${worldId}` }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'season_slots', filter: `world_id=eq.${worldId}` }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'multiplayer_readiness', filter: `world_id=eq.${worldId}` }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'career_worlds', filter: `id=eq.${worldId}` }, () => void reload())
      .subscribe();
    const poll = setInterval(() => void reload(), 15000);
    return () => { void sb.removeChannel(ch); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  // Läuft der Termin, lässt jeder Client den Server die offenen KI-Spiele berechnen (idempotent)
  useEffect(() => {
    if (state?.slot?.state !== 'live') return;
    void seasonApi.simulate(worldId);
    const t = setInterval(() => void seasonApi.simulate(worldId), 20000);
    return () => clearInterval(t);
  }, [state?.slot?.state, state?.slot?.id, worldId]);

  // Alle Spiele beendet, Termin aber noch offen (z. B. gleichzeitiges Spielende): Freigabe nachholen
  const allDone = !!state?.slot && state.slot.state === 'live' && state.fixtures.length > 0
    && state.fixtures.every((f) => f.status === 'finished' || f.status === 'released');
  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(() => void seasonApi.retryRelease(worldId).then(() => load()).catch(() => undefined), 2500);
    return () => clearTimeout(t);
  }, [allDone, worldId, load]);

  // Ergebnisse des zuletzt freigegebenen Termins
  useEffect(() => {
    if (!state?.season || !state.last_slot) { setLastResults(null); return; }
    void (async () => {
      const { data } = await requireSupabase().from('fixtures')
        .select('id, status, neutral_venue, leg, competitions!inner(name, kind), home:clubs!fixtures_home_club_id_fkey(id, name, short_name, control), away:clubs!fixtures_away_club_id_fkey(id, name, short_name, control), fixture_results(home_goals, away_goals, home_penalties, away_penalties)')
        .eq('world_id', worldId).eq('season_id', state.season!.id).eq('slot_key', state.last_slot!.key).neq('competitions.kind', 'friendly');
      setLastResults((data ?? []).map((f: any) => ({
        id: f.id, competition: f.competitions.name, kind: f.competitions.kind, status: f.status, neutral: f.neutral_venue, leg: f.leg,
        home: { ...f.home, color: null }, away: { ...f.away, color: null }, mine: f.home.id === state.my_club || f.away.id === state.my_club, decisions: {},
        result: f.fixture_results ? { home: (f.fixture_results.home_goals ?? f.fixture_results[0]?.home_goals), away: (f.fixture_results.away_goals ?? f.fixture_results[0]?.away_goals), hp: f.fixture_results.home_penalties ?? null, ap: f.fixture_results.away_penalties ?? null } : null,
      })));
    })();
  }, [state?.season?.id, state?.last_slot?.key, worldId, state?.my_club]);

  const act = (key: string, fn: () => Promise<unknown>) => void (async () => {
    setBusy(key); setError(null);
    try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();

  if (!state) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Spieltag wird geladen …" />}</Shell>;

  const slot = state.slot;
  const myFixtures = state.fixtures.filter((f) => f.mine);
  const others = state.fixtures.filter((f) => !f.mine);
  const done = state.fixtures.filter((f) => f.status === 'finished' || f.status === 'released').length;

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <ErrorBanner error={error} />
      {state.status === 'preseason' && (
        <Card className="mb-4">
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Saisonvorbereitung {state.season?.year}/{String((state.season?.year ?? 0) + 1).slice(2)}</p>
          <h1 className="display mt-1 text-4xl font-extrabold uppercase">Neue Saison</h1>
          <p className="mt-2 text-cream-dim">Wähle im Team unter „Saison“ einen Sponsor, stelle deine Elf auf und melde dich bereit. Transfers, Ticketpreise und Stadionausbau sind jetzt möglich. Sind alle bereit, werden Spielplan und Pokal ausgelost.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => navigate(`/w/${worldId}/team?tab=season`)}>Zur Saisonvorbereitung</Button>
            {state.is_host && <Button variant="secondary" busy={busy === 'fs'} onClick={() => { if (confirm('Saison jetzt für alle starten? Manager ohne Sponsor erhalten den Sicherheitsvertrag.')) act('fs', () => seasonApi.forceStartSeason(worldId)); }}>Saison jetzt starten (Host)</Button>}
          </div>
        </Card>
      )}

      {state.status === 'season' && slot && (
        <>
          <Card className="pitch-stripes mb-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">{fmtDate(slot.date)} · Saison {state.season?.year}/{String((state.season?.year ?? 0) + 1).slice(2)}</p>
                <h1 className="display text-4xl font-extrabold uppercase leading-none">{slot.label}</h1>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                <Pill tone={slot.state === 'live' ? 'good' : 'gold'}>{slot.state === 'live' ? `Läuft · ${done}/${state.fixtures.length} beendet` : 'Vorbereitung'}</Pill>
                <Pill tone={state.window.open ? 'good' : 'neutral'}>{state.window.open ? `Transferfenster offen (bis ${state.window.until_matchday}. Spieltag)` : 'Transferfenster zu'}</Pill>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1fr_330px]">
            <div className="space-y-4">
              {myFixtures.length > 0 ? myFixtures.map((f) => (
                <Card key={f.id}>
                  <p className="display text-sm font-semibold uppercase tracking-wider text-cream-dim">Dein Spiel · {f.competition}{f.leg ? ` · ${f.leg === 1 ? 'Hinspiel' : 'Rückspiel'}` : ''}{f.neutral ? ' · neutraler Platz' : ''}</p>
                  <FixtureLine f={f} big />
                  {slot.state === 'pending' && <p className="mt-3 text-sm text-cream-dim">Stelle im Team deine Aufstellung ein. Sobald alle Manager bereit sind, beginnt der Spieltag.</p>}
                  {slot.state === 'live' && (f.status === 'scheduled' || f.status === 'live') && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button busy={busy === 'live' + f.id} onClick={() => act('live' + f.id, async () => { await seasonApi.decide(f.id, 'live'); navigate(`/w/${worldId}/match/${f.id}`); })}>Live ansehen</Button>
                      {f.status === 'scheduled' && <Button variant="secondary" busy={busy === 'skip' + f.id} onClick={() => act('skip' + f.id, async () => { await seasonApi.decide(f.id, 'skip'); await seasonApi.simulate(worldId); })}>Überspringen</Button>}
                    </div>
                  )}
                  {Object.values(f.decisions).includes('skip') && f.status === 'scheduled' && <p className="mt-2 text-sm text-cream-dim">Übersprungen – das Spiel wird mit deiner Taktik berechnet (Automatik übernimmt Wechsel).</p>}
                  {f.status === 'finished' && <p className="mt-2 text-sm text-cream-dim">Beendet. Alle Ergebnisse erscheinen, sobald der Termin abgeschlossen ist.</p>}
                </Card>
              )) : (
                <Card><p className="text-cream-dim">Dein Verein hat an diesem Termin kein Spiel{slot.kind === 'cup' ? ' (ausgeschieden oder spielfrei)' : ''}. Du kannst anderen Partien zuschauen.</p></Card>
              )}

              <Card>
                <h2 className="display mb-3 text-2xl font-bold uppercase">Alle Spiele</h2>
                <ul className="divide-y divide-olive-700/60">
                  {others.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="w-28 shrink-0 text-xs text-cream-dim">{f.competition}</span>
                      <div className="min-w-0 flex-1"><FixtureLine f={f} /></div>
                      <Pill tone={f.status === 'live' ? 'good' : 'neutral'}>{STATUS[f.status] ?? f.status}</Pill>
                      {slot.state === 'live' && f.status === 'live' && <Link className="text-sm text-gold underline" to={`/w/${worldId}/match/${f.id}`}>Zuschauen</Link>}
                    </li>
                  ))}
                  {others.length === 0 && <li className="py-2 text-cream-dim">Keine weiteren Spiele.</li>}
                </ul>
                {slot.state === 'live' && <p className="mt-3 text-xs text-cream-dim">Spiele ohne Live-Zuschauer berechnet der Match-Server mit derselben Engine. Ergebnisse werden erst gemeinsam freigegeben, wenn alle Spiele beendet sind.</p>}
              </Card>

              {lastResults && lastResults.length > 0 && (
                <Card>
                  <h2 className="display mb-3 text-2xl font-bold uppercase">Ergebnisse · {state.last_slot?.label}</h2>
                  <ul className="divide-y divide-olive-700/60">
                    {lastResults.map((f) => (
                      <li key={f.id} className={`flex items-center gap-2 py-1.5 ${f.mine ? 'font-semibold text-gold' : ''}`}>
                        <span className="w-28 shrink-0 text-xs text-cream-dim">{f.competition}</span>
                        <div className="min-w-0 flex-1"><FixtureLine f={f} /></div>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            <div className="space-y-4">
              <Card className="space-y-3">
                <h2 className="display text-2xl font-bold uppercase">Manager</h2>
                <ul className="space-y-2">
                  {state.readiness.map((r) => (
                    <li key={r.user_id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{r.club} <span className="text-xs text-cream-dim">({r.username})</span></span>
                      {slot.state === 'pending' ? <Pill tone={r.ready ? 'good' : 'warn'}>{r.ready ? 'Bereit' : 'Wartet'}</Pill> : <Pill tone="good">Dabei</Pill>}
                    </li>
                  ))}
                </ul>
                {slot.state === 'pending' && (
                  <>
                    <ReadyButton state={state} busy={busy === 'ready'} onToggle={(v) => act('ready', () => seasonApi.setReady(worldId, v))} />
                    {state.is_host && <Button variant="ghost" className="w-full" busy={busy === 'force'} onClick={() => { if (confirm('Termin jetzt für alle starten? Nicht bereite Manager spielen mit ihrer gespeicherten Taktik.')) act('force', () => seasonApi.forceStart(worldId)); }}>Termin jetzt starten (Host)</Button>}
                  </>
                )}
              </Card>
              <Card>
                <h2 className="display mb-2 text-xl font-bold uppercase">Nächste Termine</h2>
                <ul className="space-y-1 text-sm">
                  {state.next_slots.map((s) => <li key={s.label + s.date} className="flex justify-between gap-2"><span>{s.label}</span><span className="text-cream-dim">{fmtDate(s.date)}</span></li>)}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

function ReadyButton({ state, busy, onToggle }: { state: MatchdayState; busy: boolean; onToggle: (ready: boolean) => void }) {
  // Eigene Bereitschaft: Eintrag des eigenen Vereins (Name aus my_club ist nicht enthalten → über user_id im Auth-Kontext)
  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { void requireSupabase().auth.getUser().then(({ data }) => setUid(data.user?.id ?? null)); }, []);
  const mine = state.readiness.find((r) => r.user_id === uid);
  return (
    <Button className="w-full" variant={mine?.ready ? 'secondary' : 'primary'} busy={busy} onClick={() => onToggle(!mine?.ready)}>
      {mine?.ready ? 'Bereitschaft zurückziehen' : 'Bereit für den Termin'}
    </Button>
  );
}

function Badge({ c }: { c: ClubRef }) {
  const color = c.color ?? '#3a4a3a';
  return <span className="display grid h-7 min-w-10 place-items-center rounded-md px-1 text-xs font-bold" style={{ background: color, color: readableTextColor(color) }}>{c.short_name}</span>;
}

export function FixtureLine({ f, big }: { f: SlotFixture; big?: boolean }) {
  const r = f.result;
  return (
    <div className={`flex items-center gap-2 ${big ? 'mt-2 text-xl' : ''}`}>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right"><span className="truncate">{f.home.name}</span><Badge c={f.home} /></span>
      <span className="display w-16 shrink-0 text-center text-xl font-bold tabular-nums">
        {r ? `${r.home}:${r.away}` : '–:–'}
        {r && r.hp !== null && r.hp !== undefined && <span className="block text-xs font-normal text-cream-dim">i. E. {r.hp}:{r.ap}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2"><Badge c={f.away} /><span className="truncate">{f.away.name}</span></span>
    </div>
  );
}
