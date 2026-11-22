import type { PlayerStatus } from '../../lib/teamApi';

const SCOPE: Record<string, string> = { league: 'Liga', domestic_cup: 'Pokal', uefa: 'Europa' };
const CARD: Record<string, string> = { yellow: '🟨 Gelbsperre', second_yellow: '🟨🟥 Gelb-Rot-Sperre', red: '🟥 Rotsperre' };

/** Kurzer Text für Tooltips und Meldungen */
export function statusText(s?: PlayerStatus): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.injury) parts.push(`Verletzt (${s.injury.kind}) bis ${new Date(s.injury.until).toLocaleDateString('de-DE')} · ${s.injury.matches === 1 ? '1 Spiel' : `${s.injury.matches} Spiele`}`);
  for (const d of Array.isArray(s.suspensions) ? s.suspensions : []) parts.push(`${CARD[d.card ?? 'red'] ?? 'Sperre'} (${SCOPE[d.scope] ?? d.scope}): noch ${d.remaining} ${d.remaining === 1 ? 'Spiel' : 'Spiele'}`);
  if (s.unavailable) parts.push('Nicht einsatzberechtigt');
  return parts.join(' · ');
}

/** Kleines Symbol (Spielfeld, Bank) */
export function StatusIcon({ s: raw }: { s?: PlayerStatus }) {
  const s = raw && { ...raw, suspensions: Array.isArray(raw.suspensions) ? raw.suspensions : [] };
  if (!s || (!s.injury && s.suspensions.length === 0)) return null;
  const icon = s.injury ? '✚' : s.suspensions.some((d) => d.card === 'red') ? '🟥' : s.suspensions.some((d) => d.card === 'second_yellow') ? '🟨🟥' : '🟨';
  return (
    <span title={statusText(s)} aria-label={statusText(s)}
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold ${s.injury ? 'bg-danger text-white' : 'bg-ink/80'} ${s.unavailable ? 'ring-2 ring-danger' : ''}`}>
      {icon}
    </span>
  );
}

/** Ausführliche Badges (Kader, Profil) */
export function StatusBadges({ s }: { s?: PlayerStatus }) {
  if (!s || (!s.injury && s.suspensions.length === 0)) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
      {s.injury && (
        <span className="rounded-md bg-danger/20 px-1.5 py-0.5 font-semibold text-red-200">
          ✚ {s.injury.kind} · bis {new Date(s.injury.until).toLocaleDateString('de-DE')} ({s.injury.matches === 1 ? '1 Spiel' : `${s.injury.matches} Spiele`})
        </span>
      )}
      {s.suspensions.map((d, i) => (
        <span key={i} className="rounded-md bg-gold/15 px-1.5 py-0.5 font-semibold text-gold">
          {CARD[d.card ?? 'red'] ?? 'Sperre'} · {SCOPE[d.scope] ?? d.scope} · noch {d.remaining}
        </span>
      ))}
      {s.unavailable && <span className="rounded-md border border-danger/60 px-1.5 py-0.5 font-semibold text-red-200">Nicht einsatzberechtigt</span>}
    </div>
  );
}
