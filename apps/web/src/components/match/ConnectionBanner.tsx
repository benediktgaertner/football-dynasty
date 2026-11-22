import { useEffect, useState } from 'react';
import { Button } from '../ui';
import type { MatchClient, MatchState } from '../../lib/matchClient';

/**
 * Verbindungsstatus während der Partie (Deutsch): erscheint bei Unterbrechung, zeigt die Wiederverbindungsversuche,
 * nach erfolgreicher Rückkehr kurz „Verbindung wiederhergestellt“ und verschwindet dann.
 */
export function ConnectionBanner({ state, client }: { state: MatchState; client: MatchClient | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (state.connection === 'reconnecting') {
    const r = state.reconnect;
    return (
      <div role="status" data-testid="conn-banner" data-conn="reconnecting" className="mt-2 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-amber-400/60 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-100">
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-300" />
        <span>Verbindung unterbrochen – verbinde neu{r ? ` (Versuch ${r.attempt} von ${r.max})` : ''} …</span>
        <span className="font-normal text-amber-100/80">Die Partie läuft auf dem Server weiter; Tore und Wechsel bleiben erhalten.</span>
      </div>
    );
  }
  if (state.connection === 'error' && state.teams) {
    return (
      <div role="alert" data-testid="conn-banner" data-conn="error" className="mt-2 flex flex-wrap items-center justify-center gap-3 rounded-xl border border-danger/60 bg-danger/15 px-3 py-2 text-sm font-semibold text-cream">
        <span>{state.error ?? 'Die Verbindung ist abgebrochen.'}</span>
        <Button className="min-h-10 !px-4 !text-sm" onClick={() => client?.retryNow()}>{state.replaced ? 'Hier fortsetzen' : 'Neu verbinden'}</Button>
      </div>
    );
  }
  if (state.connection === 'open' && state.recoveredAt && now - state.recoveredAt < 4000) {
    return (
      <div role="status" data-testid="conn-banner" data-conn="recovered" className="mt-2 rounded-xl border border-emerald-400/60 bg-emerald-500/15 px-3 py-2 text-center text-sm font-semibold text-emerald-100">
        Verbindung wiederhergestellt – du bist wieder live dabei.
      </div>
    );
  }
  return null;
}
