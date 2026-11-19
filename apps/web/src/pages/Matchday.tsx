import { readableTextColor } from '@fd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type ClubRef, type DashboardData, type MatchdayState, type SlotFixture } from '../lib/seasonApi';
import { ClubLink, ClubLogo, PlayerLink } from '../components/links';
import { requireSupabase } from '../lib/supabase';

const STATUS: Record<string, string> = { scheduled: 'Anstoß offen', live: 'Läuft', finished: 'Beendet', released: 'Beendet' };
/** KI-gegen-KI-Partien: Ergebnis wird serverseitig berechnet und erst mit der gemeinsamen Freigabe sichtbar */
export function fixtureStatus(f: SlotFixture): string {
  const ai = f.home.control === 'ai' && f.away.control === 'ai';
  if (f.status === 'released') return 'Beendet';
  if (ai) return 'Ergebnis ausstehend';
  return STATUS[f.status] ?? f.status;
}
const fmtDate = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

/** B4: Spieltags-Zentrale – Vorbereitung, Bereitschaft, Live/Überspringen, gemeinsame Freigabe */
export function Matchday() {
  const { worldId = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<MatchdayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dash, setDash] = useState<DashboardData | null>(null);
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
      const [s, d] = await Promise.all([seasonApi.matchday(worldId), seasonApi.dashboard(worldId).catch(() => null)]);
      prevSlot.current = s.slot?.id ?? null;
      setState(s);
      setDash(d);
      // Nach jeder gemeinsamen Ergebnisfreigabe: Pflicht-Spieltagsübersicht zuerst
      if (d?.pending_review) navigate(`/w/${worldId}/uebersicht/${d.pending_review.slot_id}`, { replace: true });
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally {
      loading.current = false;
      if (again.current) { again.current = false; clearTimeout(timer.current); timer.current = setTimeout(() => void load(), 800); }
    }
  }, [worldId, navigate]);
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

  // Läuft der Termin, rechnet der Server die KI-Spiele selbstständig (Sweep alle 10 s). Der Anstoß vom Client
  // beschleunigt das nur und ist idempotent – ohne ihn bleibt kein Spiel mehr hängen.
  useEffect(() => {
    if (state?.slot?.state !== 'live') return;
    void seasonApi.simulate(worldId);
    const t = setInterval(() => void seasonApi.simulate(worldId), 20000);
    return () => clearInterval(t);
  }, [state?.slot?.state, state?.slot?.id, worldId]);

  // Nicht einsatzberechtigte Spieler in der eigenen Startelf (Verletzung/Sperre) – blockiert Bereitschaft und Live-Start
  const [issues, setIssues] = useState<Array<{ player_id: string; name: string; reason: 'injured' | 'suspended' }>>([]);
  useEffect(() => {
    if (!state?.slot) return;
    void seasonApi.lineupIssues(worldId).then(setIssues).catch(() => setIssues([]));
  }, [worldId, state?.slot?.id, state?.slot?.state]);

  // Alle Spiele beendet, Termin aber noch offen (z. B. gleichzeitiges Spielende): Freigabe nachholen
  const allDone = !!state?.slot && state.slot.state === 'live' && state.fixtures.length > 0
    && state.fixtures.every((f) => f.status === 'finished' || f.status === 'released');
  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(() => void seasonApi.retryRelease(worldId).then(() => load()).catch(() => undefined), 2500);
    return () => clearTimeout(t);
  }, [allDone, worldId, load]);


  const act = (key: string, fn: () => Promise<unknown>) => void (async () => {
    setBusy(key); setError(null);
    try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();

  if (!state) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Dashboard wird geladen …" />}</Shell>;

  const slot = state.slot;
  const myFixtures = state.fixtures.filter((f) => f.mine);
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
            <Button variant="secondary" onClick={() => navigate(`/w/${worldId}/entwicklung`)}>Entwicklungsbericht der Vorsaison</Button>
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
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Pill tone={slot.state === 'live' ? 'good' : 'gold'}>{slot.state === 'live' ? `Läuft · ${done}/${state.fixtures.length} beendet` : 'Vorbereitung'}</Pill>
                <Pill tone={state.window.open ? 'good' : 'neutral'}>{state.window.open ? `Transferfenster offen (bis ${state.window.until_matchday}. Spieltag)` : 'Transferfenster zu'}</Pill>
                <Link to={`/w/${worldId}/kalender`} className="text-sm font-semibold text-gold underline">Alle Begegnungen</Link>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              {/* Nächste Begegnung */}
              {myFixtures.length > 0 ? myFixtures.map((f) => (
                <NextMatchCard key={f.id} f={f} dash={dash} slotLabel={slot.label} slotDate={slot.date}>
                  {slot.state === 'pending' && <p className="mt-3 text-sm text-cream-dim">Bereite in „Aufstellung & Taktik“ deine Elf vor. Sobald alle Manager bereit sind, beginnt der Spieltag.</p>}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {slot.state === 'pending' && <Button variant="secondary" onClick={() => navigate(`/w/${worldId}/team?tab=tactics`)}>Spielvorbereitung</Button>}
                    {slot.state === 'live' && (f.status === 'scheduled' || f.status === 'live') && (
                      <>
                        <Button busy={busy === 'live' + f.id} disabled={issues.length > 0} title={issues.length > 0 ? 'Startelf enthält nicht einsatzberechtigte Spieler' : undefined} onClick={() => act('live' + f.id, async () => { await seasonApi.decide(f.id, 'live'); navigate(`/w/${worldId}/match/${f.id}`); })}>Spiel starten</Button>
                        {f.status === 'scheduled' && <Button variant="secondary" busy={busy === 'skip' + f.id} onClick={() => act('skip' + f.id, async () => { await seasonApi.decide(f.id, 'skip'); await seasonApi.simulate(worldId); })}>Überspringen</Button>}
                      </>
                    )}
                  </div>
                  {Object.values(f.decisions).includes('skip') && f.status === 'scheduled' && <p className="mt-2 text-sm text-cream-dim">Übersprungen – das Spiel wird mit deiner Taktik berechnet (Automatik übernimmt Wechsel).</p>}
                  {f.status === 'finished' && <p className="mt-2 text-sm text-cream-dim">Beendet. Alle Ergebnisse erscheinen gemeinsam, sobald alle Manager fertig sind.</p>}
                </NextMatchCard>
              )) : dash?.next ? (
                <NextMatchCard dash={dash} slotLabel={dash.next.label ?? ''} slotDate={dash.next.date}>
                  <p className="mt-3 text-sm text-cream-dim">An diesem Termin hast du spielfrei{slot.kind === 'cup' ? ' (ausgeschieden oder spielfrei)' : ''}.</p>
                </NextMatchCard>
              ) : <Card><p className="text-cream-dim">Keine anstehende Begegnung.</p></Card>}

              <div className="grid gap-4 lg:grid-cols-2">
                <MiniTable dash={dash} worldId={worldId} />
                <TopStats dash={dash} />
              </div>
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
                    {issues.length > 0 && <LineupIssues issues={issues} worldId={worldId} />}
                    <ReadyButton state={state} busy={busy === 'ready'} onToggle={(v) => act('ready', () => seasonApi.setReady(worldId, v))} />
                    {state.is_host && <Button variant="ghost" className="w-full" busy={busy === 'force'} onClick={() => { if (confirm('Termin jetzt für alle starten? Nicht bereite Manager spielen mit ihrer gespeicherten Taktik.')) act('force', () => seasonApi.forceStart(worldId)); }}>Termin jetzt starten (Host)</Button>}
                  </>
                )}
                {slot.state === 'live' && <p className="text-xs text-cream-dim">KI-Spiele werden serverseitig berechnet; alle Ergebnisse werden gemeinsam freigegeben, sobald jeder Manager sein Spiel beendet oder übersprungen hat.</p>}
              </Card>
              <CalendarCard dash={dash} worldId={worldId} />
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

function ReadyButton({ state, busy, onToggle }: { state: MatchdayState; busy: boolean; onToggle: (ready: boolean) => void }) {
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
      <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right"><ClubLink club={f.home} className="truncate" /><Badge c={f.home} /></span>
      <span className="display w-16 shrink-0 text-center text-xl font-bold tabular-nums">
        {r ? `${r.home}:${r.away}` : '–:–'}
        {r && r.hp !== null && r.hp !== undefined && <span className="block text-xs font-normal text-cream-dim">i. E. {r.hp}:{r.ap}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2"><Badge c={f.away} /><ClubLink club={f.away} className="truncate" /></span>
    </div>
  );
}

/** Nächste Begegnung: Gegner mit Logo, Wettbewerb, Spieltag, Datum, Heim/Auswärts */
function NextMatchCard({ f, dash, slotLabel, slotDate, children }: { f?: SlotFixture; dash: DashboardData | null; slotLabel: string; slotDate: string; children?: React.ReactNode }) {
  const n = dash?.next;
  const my = dash?.my_club;
  const opp = n?.opponent ?? (f ? (f.home.id === my?.id ? f.away : f.home) : null);
  const home = n ? n.home : f ? f.home.id === my?.id : true;
  const r = f?.result;
  return (
    <Card className="overflow-hidden">
      <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Nächste Begegnung</p>
      <p className="text-sm text-cream-dim">{n?.competition ?? f?.competition}{n?.matchday ? ` · ${n.matchday}. Spieltag` : ` · ${slotLabel}`} · {fmtDate(n?.date ?? slotDate)}{(n?.leg ?? f?.leg) ? ` · ${(n?.leg ?? f?.leg) === 1 ? 'Hinspiel' : 'Rückspiel'}` : ''}</p>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex flex-col items-center gap-2 text-center">
          {my && (home ? <ClubLogo club={my} size={72} /> : opp && <ClubLogo club={opp as never} size={72} />)}
          <span className="display text-xl font-bold uppercase leading-tight">{home ? my?.name : <ClubLink club={opp}>{opp?.name}</ClubLink>}</span>
        </div>
        <div className="text-center">
          <span className="display text-5xl font-extrabold tabular-nums">{r ? `${r.home}:${r.away}` : 'vs'}</span>
          <p className="mt-1"><Pill tone={home ? 'good' : 'neutral'}>{(n?.neutral ?? f?.neutral) ? 'Neutraler Platz' : home ? 'Heimspiel' : 'Auswärtsspiel'}</Pill></p>
          {n?.stadium && !(n?.neutral) && <p className="mt-1 text-xs text-cream-dim">{n.stadium}</p>}
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          {my && (!home ? <ClubLogo club={my} size={72} /> : opp && <ClubLogo club={opp as never} size={72} />)}
          <span className="display text-xl font-bold uppercase leading-tight">{!home ? my?.name : <ClubLink club={opp}>{opp?.name}</ClubLink>}</span>
        </div>
      </div>
      {children}
    </Card>
  );
}

/** Kompakte Tabelle: eigener Platz hervorgehoben, mindestens zwei Teams darüber und darunter */
function MiniTable({ dash, worldId }: { dash: DashboardData | null; worldId: string }) {
  const rows = dash?.league?.rows ?? [];
  const me = rows.findIndex((r) => r.club.id === dash?.my_club.id);
  const from = Math.max(0, Math.min(me - 2, rows.length - 5));
  const view = me < 0 ? rows.slice(0, 5) : rows.slice(from, from + 5);
  return (
    <Card>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="display text-xl font-bold uppercase">{dash?.league?.name ?? 'Tabelle'}</h2>
        <Link to={`/w/${worldId}/liga`} className="text-sm font-semibold text-gold underline">Ganze Tabelle</Link>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase text-cream-dim"><tr><th className="py-1">#</th><th>Verein</th><th className="text-right">Sp</th><th className="text-right">Tore</th><th className="text-right">Diff</th><th className="text-right">Pkt</th></tr></thead>
        <tbody>
          {view.map((r) => {
            const mine = r.club.id === dash?.my_club.id;
            return (
              <tr key={r.club.id} className={`border-t border-olive-700/50 ${mine ? 'bg-gold/15 font-bold text-gold' : ''}`}>
                <td className="py-1.5 tabular-nums">{r.pos}</td>
                <td className="max-w-0"><span className="flex items-center gap-2"><ClubLogo club={r.club} size={20} /><ClubLink club={r.club} className="truncate" /></span></td>
                <td className="text-right tabular-nums">{r.played}</td>
                <td className="text-right tabular-nums">{r.gf}:{r.ga}</td>
                <td className="text-right tabular-nums">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                <td className="display text-right text-lg tabular-nums">{r.points}</td>
              </tr>
            );
          })}
          {view.length === 0 && <tr><td colSpan={6} className="py-2 text-cream-dim">Noch keine Tabelle.</td></tr>}
        </tbody>
      </table>
    </Card>
  );
}

/** Top-Statistiken der eigenen Liga */
function TopStats({ dash }: { dash: DashboardData | null }) {
  const [tab, setTab] = useState<'scorers' | 'assists' | 'ratings'>('scorers');
  const l = dash?.leaders;
  const list = (l?.[tab] ?? []).slice(0, 5);
  const val = (r: NonNullable<typeof l>['scorers'][number]) => tab === 'scorers' ? `${r.goals} Tore` : tab === 'assists' ? `${r.assists} Vorl.` : (r.rating ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2 });
  return (
    <Card>
      <h2 className="display mb-2 text-xl font-bold uppercase">Top-Statistiken</h2>
      <div className="mb-2 flex gap-1">
        {([['scorers', 'Torschützen'], ['assists', 'Vorlagen'], ['ratings', 'Noten']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${tab === k ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>{label}</button>
        ))}
      </div>
      <ol className="space-y-1 text-sm">
        {list.map((r, i) => (
          <li key={r.player_id} className="flex items-center gap-2 rounded-lg bg-olive-800/70 px-2 py-1.5">
            <span className="w-4 text-cream-dim">{i + 1}</span>
            <PlayerLink id={r.player_id} className="min-w-0 flex-1 truncate font-semibold">{r.player}</PlayerLink>
            <span className="text-xs text-cream-dim">{r.club}</span>
            <span className="display w-16 text-right font-bold tabular-nums">{val(r)}</span>
          </li>
        ))}
        {list.length === 0 && <li className="text-cream-dim">Noch keine Daten – Statistiken entstehen mit den freigegebenen Spielen.</li>}
      </ol>
      {(dash?.best_offense || dash?.best_defense) && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          {dash.best_offense && <div className="rounded-lg bg-olive-800/70 p-2"><p className="uppercase text-cream-dim">Beste Offensive</p><ClubLink club={dash.best_offense.club} className="font-semibold" /><p className="display text-lg font-bold">{dash.best_offense.value} Tore</p></div>}
          {dash.best_defense && <div className="rounded-lg bg-olive-800/70 p-2"><p className="uppercase text-cream-dim">Beste Defensive</p><ClubLink club={dash.best_defense.club} className="font-semibold" /><p className="display text-lg font-bold">{dash.best_defense.value} Gegentore</p></div>}
        </div>
      )}
    </Card>
  );
}

/** Kompakter Kalender: nächste Begegnungen und letzte Ergebnisse */
function CalendarCard({ dash, worldId }: { dash: DashboardData | null; worldId: string }) {
  return (
    <Card>
      <div className="mb-2 flex items-baseline justify-between"><h2 className="display text-xl font-bold uppercase">Kalender</h2><Link to={`/w/${worldId}/kalender`} className="text-sm font-semibold text-gold underline">Alle Begegnungen</Link></div>
      <ul className="space-y-1 text-sm">
        {(dash?.calendar ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-cream-dim">{new Date(c.date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
            <span className="w-5 text-xs font-bold text-cream-dim">{c.home ? 'H' : 'A'}</span>
            <ClubLogo club={c.opponent} size={18} />
            <ClubLink club={c.opponent} className="min-w-0 flex-1 truncate" />
            <span className="text-[11px] text-cream-dim">{c.kind === 'domestic_cup' ? 'Pokal' : c.label}</span>
          </li>
        ))}
        {(dash?.calendar ?? []).length === 0 && <li className="text-cream-dim">Keine weiteren Termine.</li>}
      </ul>
      {(dash?.recent ?? []).length > 0 && (
        <>
          <p className="mt-3 text-xs uppercase text-cream-dim">Letzte Ergebnisse</p>
          <div className="mt-1 flex gap-1">
            {dash!.recent.map((r) => (
              <span key={r.id} title={`${r.home ? 'H' : 'A'} ${r.opponent.name} ${r.gf}:${r.ga}`}
                className={`display grid h-8 w-8 place-items-center rounded-md text-sm font-bold ${r.gf > r.ga ? 'bg-emerald-600 text-white' : r.gf < r.ga ? 'bg-danger text-white' : 'bg-olive-600'}`}>
                {r.gf > r.ga ? 'S' : r.gf < r.ga ? 'N' : 'U'}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function LineupIssues({ issues, worldId }: { issues: Array<{ player_id: string; name: string; reason: 'injured' | 'suspended' }>; worldId: string }) {
  return (
    <div className="mb-3 rounded-xl border border-danger/60 bg-danger/10 p-3 text-sm">
      <p className="font-semibold text-red-200">Ungültige Startelf – Anpfiff gesperrt</p>
      <ul className="mt-1 list-disc pl-5">{issues.map((i) => <li key={i.player_id}><PlayerLink id={i.player_id}>{i.name}</PlayerLink>: {i.reason === 'injured' ? '✚ verletzt' : 'gesperrt'}</li>)}</ul>
      <Link to={`/w/${worldId}/team?tab=tactics`} className="mt-2 inline-block font-semibold text-gold underline">Jetzt in „Aufstellung & Taktik“ ersetzen</Link>
    </div>
  );
}
