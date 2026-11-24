import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { formatEuro } from '../lib/api';
import { useAuth } from '../lib/auth';
import { loadTeam, teamApi, type ClubTactics, type ProfileState, type SquadPlayer, type TeamContext } from '../lib/teamApi';
import { Crest } from '../components/Crest';
import { Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { PlayerProfile, SeasonTab, SetPiecesTab, SquadTab, TrainingTab } from '../components/team/OtherTabs';
import { TrainingPlanCard } from '../components/team/TrainingPlanCard';
import { TacticsTab } from '../components/team/TacticsTab';
import { FriendliesTab } from '../components/team/FriendliesTab';

type Tab = 'tactics' | 'squad' | 'setpieces' | 'training' | 'matches' | 'season';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'tactics', label: 'Aufstellung & Taktik' },
  { key: 'squad', label: 'Kader' },
  { key: 'setpieces', label: 'Standards' },
  { key: 'training', label: 'Training' },
  { key: 'matches', label: 'Spiele' },
  { key: 'season', label: 'Sponsor & Saisonstart' },
];

type Loaded = Awaited<ReturnType<typeof loadTeam>>;

/** L3: Team-Management – Kader, Spielerprofile, Aufstellung, drei Taktikprofile, Anweisungen, Standards, Training. */
export function Team() {
  const { worldId = '' } = useParams();
  const { session } = useAuth();
  const [data, setData] = useState<Loaded | null>(null);
  const [profiles, setProfiles] = useState<ProfileState[]>([]);
  const [clubTactics, setClubTactics] = useState<ClubTactics | null>(null);
  const [setPieces, setSetPieces] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab | null) ?? 'tactics');
  // Sponsor & Saisonstart nur in der Vorbereitung (danach ist der Sponsor festgelegt)
  const [profileOpen, setProfileOpen] = useState<SquadPlayer | null>(null);

  const reload = useCallback(async (full = true) => {
    try {
      const d = await loadTeam(worldId);
      setData(d);
      if (full) {
        setProfiles(d.profiles);
        setClubTactics(d.tactics);
        setSetPieces(d.setPieces);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [worldId]);

  useEffect(() => {
    void reload(true);
    // Bereitschaft der Mitspieler regelmäßig aktualisieren (ohne lokale Bearbeitungen zu überschreiben)
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void reload(false); }, 20000);
    return () => clearInterval(poll);
  }, [worldId, reload]);

  if (!data || !clubTactics) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Team wird geladen …" />}</Shell>;

  const kit = { primary: data.branding.kit.primary, secondary: data.branding.kit.secondary };
  const ctx: TeamContext = data.ctx;
  const lowFitness = data.squad.filter((p) => p.fitness < 70).length;

  return (
    <Shell right={<Link to="/" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Übersicht</Link>}>
      <WorldNav worldId={worldId} />
      <Card className="pitch-stripes mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <Crest crest={data.branding.crest} size={56} />
          <div>
            <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">{ctx.league} · Saison {ctx.season_year}/{String(ctx.season_year + 1).slice(2)}</p>
            <h1 className="display text-4xl font-extrabold uppercase leading-none">{data.club.name}</h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Pill tone="gold">Konto {formatEuro(ctx.balance)}</Pill>
            <Pill>{data.squad.length} Spieler</Pill>
            {lowFitness > 0 && <Pill tone="warn">{lowFitness} mit Fitness &lt; 70</Pill>}
            <Pill tone={ctx.world_status === 'preseason' ? 'neutral' : 'good'}>{ctx.world_status === 'preseason' ? 'Saisonvorbereitung' : 'Saison läuft'}</Pill>
            <Link to={`/w/${worldId}/draft`} className="text-sm text-gold underline-offset-4 hover:underline">Draft-Rückblick</Link>
          </div>
        </div>
      </Card>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Team-Bereiche">
        {TABS.filter((t) => t.key !== 'season' || ctx.world_status === 'preseason').map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} className={`display min-h-11 rounded-full px-5 text-base font-semibold uppercase ${tab === t.key ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="mb-4"><ErrorBanner error={error} /></div>

      {tab === 'tactics' && (
        <TacticsTab
          profiles={profiles}
          setProfiles={setProfiles}
          squad={data.squad}
          clubTactics={clubTactics}
          setClubTactics={setClubTactics}
          kit={kit}
          onSaveProfile={async (p) => {
            await teamApi.saveProfile(worldId, p);
          }}
          onSaveClubTactics={async () => {
            await teamApi.saveClubTactics(worldId, clubTactics);
          }}
        />
      )}
      {tab === 'squad' && <SquadTab squad={data.squad} kit={kit} onOpen={setProfileOpen} />}
      {tab === 'setpieces' && (
        <SetPiecesTab
          squad={data.squad}
          setPieces={setPieces}
          setSetPieces={setSetPieces}
          clubTactics={clubTactics}
          setClubTactics={setClubTactics}
          onSave={async () => {
            await teamApi.saveSetPieces(worldId, setPieces);
            await teamApi.saveClubTactics(worldId, clubTactics);
          }}
        />
      )}
      {tab === 'training' && <TrainingPlanCard worldId={worldId} squad={data.squad} onChanged={() => void reload(false)} />}
      {tab === 'training' && (
        <TrainingTab
          squad={data.squad}
          ctx={ctx}
          kit={kit}
          onTrain={async (playerId, focus) => {
            const r = await teamApi.train(worldId, playerId, focus);
            await reload(false);
            return { points: r.points, total: r.total_points, gains: r.gains, ovrBefore: r.ovr_before, ovrAfter: r.ovr_after };
          }}
        />
      )}
      {tab === 'matches' && <FriendliesTab worldId={worldId} myClubId={ctx.club_id} />}
      {tab === 'season' && ctx.world_status === 'preseason' && (
        <SeasonTab
          ctx={ctx}
          myUserId={session?.user.id ?? ''}
          onChoose={async (id) => {
            await teamApi.chooseSponsor(worldId, id);
            await reload(false);
          }}
          onReady={async (ready) => {
            await teamApi.setReady(worldId, ready);
            await reload(false);
          }}
        />
      )}
      {profileOpen && <PlayerProfile key={profileOpen.id} player={profileOpen} kit={kit} onClose={() => setProfileOpen(null)} onShirtNumber={async (number) => {
        await teamApi.setShirtNumber(worldId, profileOpen.id, number);
        setProfileOpen({ ...profileOpen, shirt_number: number });
        await reload(false);
      }} />}
    </Shell>
  );
}
