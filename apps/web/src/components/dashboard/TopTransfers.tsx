import { useEffect, useState } from 'react';
import { formatEuro } from '../../lib/api';
import { seasonApi, type TopTransfer } from '../../lib/seasonApi';
import { ClubLink, ClubLogo, PlayerLink } from '../links';
import { POS_LABEL } from '../team/PitchEditor';
import { OvrChip } from '../team/Ovr';
import { Card } from '../ui';

/** Kompakter, umschaltbarer Bereich: Top-5-Transfers der eigenen Liga bzw. der ganzen Spielwelt, Sommer/Winter */
export function TopTransfers({ worldId }: { worldId: string }) {
  const [scope, setScope] = useState<'league' | 'world'>('league');
  const [win, setWin] = useState<1 | 2 | null>(null);
  const [rows, setRows] = useState<TopTransfer[] | null>(null);
  const [league, setLeague] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    void seasonApi.topTransfers(worldId, scope, win).then((r) => { setRows(r.rows); setLeague(r.league); if (win === null) setWin(r.window === 2 ? 2 : 1); }).catch(() => setRows([]));
  }, [worldId, scope, win]);
  const tab = (active: boolean) => `min-h-9 rounded-lg px-3 text-sm font-semibold ${active ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`;
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="display text-xl font-bold uppercase">Top-Transfers</h2>
        <div className="ml-auto flex gap-1" role="group" aria-label="Bereich">
          <button type="button" className={tab(scope === 'league')} aria-pressed={scope === 'league'} onClick={() => setScope('league')}>Liga</button>
          <button type="button" className={tab(scope === 'world')} aria-pressed={scope === 'world'} onClick={() => setScope('world')}>Welt</button>
        </div>
        <div className="flex gap-1" role="group" aria-label="Transferphase">
          <button type="button" className={tab(win === 1)} aria-pressed={win === 1} onClick={() => setWin(1)}>Sommer</button>
          <button type="button" className={tab(win === 2)} aria-pressed={win === 2} onClick={() => setWin(2)}>Winter</button>
        </div>
      </div>
      <p className="mb-1 text-xs text-cream-dim">{scope === 'league' ? league ?? 'Eigene Liga' : 'Alle Ligen und Länder'} · teuerste abgeschlossene Transfers</p>
      {rows === null ? <p className="text-sm text-cream-dim">Wird geladen …</p> : rows.length === 0 ? <p className="text-sm text-cream-dim">Noch keine Ablösetransfers in dieser Phase.</p> : (
        <ol className="space-y-1.5">
          {rows.map((t, i) => (
            <li key={t.player_id + i} className="flex items-center gap-2 rounded-lg bg-olive-800/50 px-2 py-1.5 text-sm">
              <span className="display w-4 text-lg font-bold text-cream-dim">{i + 1}</span>
              <OvrChip value={t.overall} />
              <div className="min-w-0 flex-1">
                <PlayerLink id={t.player_id} className="block truncate font-semibold">{t.name}</PlayerLink>
                <div className="flex items-center gap-1 text-[11px] text-cream-dim">
                  <span>{t.age} J. · {POS_LABEL[t.position] ?? t.position}</span>
                  <span className="mx-1">·</span>
                  {t.from && <><ClubLogo club={t.from} size={14} /><ClubLink club={t.from} className="max-w-24 truncate" /></>}
                  <span aria-hidden>→</span>
                  {t.to && <><ClubLogo club={t.to} size={14} /><ClubLink club={t.to} className="max-w-24 truncate" /></>}
                </div>
              </div>
              <span className="display shrink-0 text-base font-bold text-gold">{formatEuro(t.fee)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
