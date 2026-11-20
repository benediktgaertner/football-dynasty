import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { matchApi, matchServerUrl, type FixtureSummary, type OpponentClub } from '../../lib/matchApi';
import { Button, Card, ErrorBanner, Pill } from '../ui';

const STATUS: Record<string, string> = { scheduled: 'Bereit', live: 'Läuft', finished: 'Beendet', released: 'Beendet', cancelled: 'Abgesagt' };

/** Testspiele: echte Live-Partien über den Match-Server, ohne Folgen für Fitness, Tabelle oder Finanzen. */
export function FriendliesTab({ worldId, myClubId }: { worldId: string; myClubId: string }) {
  const [clubs, setClubs] = useState<OpponentClub[]>([]);
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [opponent, setOpponent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, f] = await Promise.all([matchApi.opponents(worldId), matchApi.myFixtures(worldId)]);
      setClubs(c.filter((x) => x.id !== myClubId));
      setFixtures(f);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [worldId, myClubId]);

  useEffect(() => {
    void reload();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 20000);
    return () => clearInterval(poll);
  }, [worldId, reload]);

  const humans = clubs.filter((c) => c.control === 'human');
  const ais = clubs.filter((c) => c.control === 'ai');
  const open = fixtures.find((f) => f.mine && (f.status === 'scheduled' || f.status === 'live'));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <Card>
        <h2 className="display text-2xl font-bold uppercase">Testspiel vereinbaren</h2>
        <p className="mt-1 text-sm text-cream-dim">
          Live-Partie über 90 Minuten (3 Minuten Echtzeit) mit deiner aktuellen Taktik. Testspiele verändern weder Fitness noch Tabelle.
          Ist der Gegner ein Mitspieler, kann er live mitsteuern – sonst übernimmt die Automatik.
        </p>
        {!matchServerUrl() && <p className="mt-2 text-sm text-danger">Hinweis: VITE_MATCH_SERVER_URL ist nicht gesetzt – Spiele können nicht gestartet werden.</p>}
        <label className="mt-4 block">
          <span className="display mb-1 block text-sm font-semibold uppercase tracking-wider text-cream-dim">Gegner</span>
          <select value={opponent} onChange={(e) => setOpponent(e.target.value)} className="min-h-11 w-full rounded-xl border border-olive-600 bg-olive-800 px-3 text-cream">
            <option value="">Bitte wählen …</option>
            {humans.length > 0 && <optgroup label="Mitspieler">{humans.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
            <optgroup label="KI-Vereine">{ais.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.association_code})</option>)}</optgroup>
          </select>
        </label>
        <div className="mt-3"><ErrorBanner error={error} /></div>
        <Button className="mt-3 w-full" disabled={!opponent || !!open} busy={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await matchApi.createFriendly(worldId, opponent); setOpponent(''); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>Testspiel anlegen</Button>
        {open && <p className="mt-2 text-sm text-cream-dim">Du hast bereits ein offenes Testspiel.</p>}
      </Card>
      <Card>
        <h2 className="display text-2xl font-bold uppercase">Spiele</h2>
        <ul className="mt-3 space-y-2">
          {fixtures.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-olive-800 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-semibold">{f.home.name} – {f.away.name}</span>
              {f.result && <span className="display text-xl font-bold tabular-nums">{f.result.home}:{f.result.away}</span>}
              <Pill tone={f.status === 'live' ? 'good' : f.status === 'scheduled' ? 'gold' : 'neutral'}>{STATUS[f.status]}</Pill>
              {(f.status === 'scheduled' || f.status === 'live') && (
                <Link to={`/w/${worldId}/match/${f.id}`} className="display rounded-lg bg-gold px-3 py-1.5 font-semibold uppercase text-ink">{f.mine ? 'Zum Spiel' : 'Zuschauen'}</Link>
              )}
              {f.status === 'scheduled' && f.mine && (
                <Button variant="ghost" className="!min-h-9 !px-3 !text-sm" onClick={async () => { try { await matchApi.cancelFriendly(f.id); await reload(); } catch (e) { setError((e as Error).message); } }}>Absagen</Button>
              )}
            </li>
          ))}
          {fixtures.length === 0 && <li className="text-sm text-cream-dim">Noch keine Spiele.</li>}
        </ul>
      </Card>
    </div>
  );
}
