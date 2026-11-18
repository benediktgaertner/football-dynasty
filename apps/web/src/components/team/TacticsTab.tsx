import {
  ADVANCED_OPTIONS,
  FORMATIONS,
  PLAYER_INSTRUCTIONS,
  TACTICAL_PROFILE_NAMES,
  TEAM_SETTINGS,
  autoLineup,
  getFormation,
  roleGroup,
  tacticLoadFactor,
  validateLineup,
  validatePlayerInstructions,
  type AdvancedOptionKey,
  type LineupSlot,
  type Position,
  type TacticalProfileName,
  type TeamSettingKey,
} from '@fd/shared';
import { useMemo, useState } from 'react';
import type { ClubTactics, ProfileState, SquadPlayer } from '../../lib/teamApi';
import { Button, Card, ErrorBanner, Pill } from '../ui';
import { PitchEditor, POS_LABEL, SlotPicker } from './PitchEditor';

export const PROFILE_LABEL: Record<TacticalProfileName, string> = { offensive: 'Offensiv', neutral: 'Neutral', defensive: 'Defensiv' };

function Segmented<T extends string | number | boolean>({ value, values, labels, onChange }: { value: T; values: readonly T[]; labels: readonly string[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v, i) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={`min-h-9 rounded-lg px-2 text-sm transition ${v === value ? 'bg-gold font-semibold text-ink' : 'bg-anthracite text-cream-dim hover:text-cream'}`}
        >
          {labels[i]}
        </button>
      ))}
    </div>
  );
}

export function TacticsTab({
  profiles,
  setProfiles,
  squad,
  clubTactics,
  setClubTactics,
  kit,
  onSaveProfile,
  onSaveClubTactics,
}: {
  profiles: ProfileState[];
  setProfiles: (p: ProfileState[]) => void;
  squad: SquadPlayer[];
  clubTactics: ClubTactics;
  setClubTactics: (t: ClubTactics) => void;
  kit: { primary: string; secondary: string };
  onSaveProfile: (p: ProfileState) => Promise<void>;
  onSaveClubTactics: () => Promise<void>;
}) {
  const [active, setActive] = useState<TacticalProfileName>(clubTactics.active_profile);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [panel, setPanel] = useState<'team' | 'advanced' | 'auto'>('team');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const profile = profiles.find((p) => p.name === active)!;
  const update = (patch: Partial<ProfileState>) => {
    setNotice(null);
    setProfiles(profiles.map((p) => (p.name === active ? { ...p, ...patch } : p)));
  };
  const setSlots = (slots: LineupSlot[]) => update({ slots });
  const lineupIds = useMemo(() => new Set(profile.slots.map((s) => s.playerId).filter(Boolean) as string[]), [profile.slots]);
  const squadIds = useMemo(() => new Set(squad.map((p) => p.id)), [squad]);
  const lineupProblem = validateLineup(profile.slots, squadIds);
  const load = tacticLoadFactor({
    pressingIntensity: profile.team_instructions.pressingIntensity as 1 | 2 | 3 | 4 | 5,
    tempo: profile.team_instructions.tempo as 1 | 2 | 3 | 4 | 5,
    defensiveLine: profile.team_instructions.defensiveLine as 1 | 2 | 3 | 4 | 5,
    counterPress: profile.team_instructions.onBallLost === 'counter_press',
  });
  const selected = selectedSlot === null ? null : profile.slots.find((s) => s.slotIndex === selectedSlot) ?? null;
  const selectedPlayer = selected?.playerId ? squad.find((p) => p.id === selected.playerId) : undefined;

  function assign(playerId: string) {
    if (!selected) return;
    const other = profile.slots.find((s) => s.playerId === playerId && s.slotIndex !== selected.slotIndex);
    setSlots(
      profile.slots.map((s) => {
        if (s.slotIndex === selected.slotIndex) return { ...s, playerId };
        if (other && s.slotIndex === other.slotIndex) return { ...s, playerId: selected.playerId };
        return s;
      }),
    );
  }

  function changeFormation(code: string) {
    const f = getFormation(code);
    if (!f) return;
    const gkPlayer = profile.slots.find((s) => s.position === 'GK')?.playerId ?? null;
    const fieldPlayers = profile.slots.filter((s) => s.position !== 'GK').map((s) => s.playerId);
    let i = 0;
    update({
      formation_code: code,
      slots: f.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y, playerId: s.position === 'GK' ? gkPlayer : (fieldPlayers[i++] ?? null) })),
    });
  }

  function moveSlot(slotIndex: number, x: number, y: number, position: Position) {
    setSlots(profile.slots.map((s) => (s.slotIndex === slotIndex ? { ...s, x, y, position } : s)));
  }

  function toggleInstruction(code: string) {
    if (!selected?.playerId) return;
    const current = profile.instructions[selected.playerId] ?? [];
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    const problem = validatePlayerInstructions(selected.position, next);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    update({ instructions: { ...profile.instructions, [selected.playerId]: next } });
  }

  async function save() {
    setBusy('save');
    setError(null);
    try {
      // Anweisungen bereinigen, die nach Rollenwechsel nicht mehr passen
      const cleaned: Record<string, string[]> = {};
      for (const s of profile.slots) {
        if (!s.playerId) continue;
        const codes = (profile.instructions[s.playerId] ?? []).filter((c) => PLAYER_INSTRUCTIONS[roleGroup(s.position)].some((i) => i.code === c));
        if (codes.length) cleaned[s.playerId] = codes;
      }
      const toSave = { ...profile, instructions: cleaned };
      await onSaveProfile(toSave);
      update({ instructions: cleaned });
      setNotice(`Profil „${PROFILE_LABEL[active]}“ gespeichert.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function copyTo(target: TacticalProfileName) {
    setProfiles(profiles.map((p) => (p.name === target ? { ...profile, id: p.id, name: target } : p)));
    setNotice(`In „${PROFILE_LABEL[target]}“ kopiert. Dort noch speichern.`);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
      <div className="space-y-3 lg:w-[max(360px,calc(min(58vh,680px)*0.68))]">
        <div className="flex flex-wrap items-center gap-2">
          {TACTICAL_PROFILE_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => { setActive(n); setSelectedSlot(null); setNotice(null); }}
              className={`display min-h-10 rounded-full px-4 text-base font-semibold uppercase ${n === active ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}
            >
              {PROFILE_LABEL[n]}
              {clubTactics.active_profile === n && <span className="ml-1 text-xs">●</span>}
            </button>
          ))}
          <select value={profile.formation_code} onChange={(e) => changeFormation(e.target.value)} className="ml-auto min-h-10 rounded-xl border border-olive-600 bg-anthracite px-3 text-cream" aria-label="Formation">
            {FORMATIONS.map((f) => (
              <option key={f.code} value={f.code}>{f.name}</option>
            ))}
          </select>
        </div>
        <PitchEditor slots={profile.slots} squad={squad} selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} onMoveSlot={moveSlot} kit={kit} />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setSlots(autoLineup(profile.slots.map(({ playerId: _p, ...s }) => s), squad.map((p) => ({ ...p }))))}
          >
            Automatisch aufstellen
          </Button>
          <Button onClick={() => void save()} busy={busy === 'save'} disabled={!!lineupProblem}>
            Profil speichern
          </Button>
          <select onChange={(e) => { if (e.target.value) copyTo(e.target.value as TacticalProfileName); e.target.value = ''; }} defaultValue="" className="min-h-11 rounded-xl border border-olive-600 bg-anthracite px-3 text-sm text-cream-dim" aria-label="Profil kopieren">
            <option value="">Kopieren nach …</option>
            {TACTICAL_PROFILE_NAMES.filter((n) => n !== active).map((n) => (
              <option key={n} value={n}>{PROFILE_LABEL[n]}</option>
            ))}
          </select>
        </div>
        {lineupProblem && <p className="text-sm text-sunset">{lineupProblem}</p>}
        {notice && <p className="text-sm text-pitch-light">{notice}</p>}
        <ErrorBanner error={error} />
        <p className="text-xs text-cream-dim">Tippe einen Spieler an, um ihn zu tauschen und ihm Anweisungen zu geben. Ziehe ihn, um seine Position frei zu verändern – die Rolle passt sich der Feldposition an.</p>
      </div>

      <div className="space-y-4">
        {selected ? (
          <Card>
            <SlotPicker
              slot={selected}
              squad={squad}
              lineupIds={lineupIds}
              onAssign={assign}
              onChangeRole={(position) => setSlots(profile.slots.map((s) => (s.slotIndex === selected.slotIndex ? { ...s, position } : s)))}
              kit={kit}
            />
            {selectedPlayer && (
              <div className="mt-4">
                <div className="display mb-2 text-base font-bold uppercase text-cream-dim">Anweisungen für {selectedPlayer.last_name} ({POS_LABEL[selected.position]})</div>
                <div className="flex flex-wrap gap-2">
                  {PLAYER_INSTRUCTIONS[roleGroup(selected.position)].map((i) => {
                    const on = (profile.instructions[selectedPlayer.id] ?? []).includes(i.code);
                    return (
                      <button key={i.code} type="button" onClick={() => toggleInstruction(i.code)} className={`min-h-9 rounded-lg px-3 text-sm ${on ? 'bg-gold font-semibold text-ink' : 'bg-anthracite text-cream-dim hover:text-cream'}`}>
                        {i.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {(['team', 'advanced', 'auto'] as const).map((p) => (
                <button key={p} type="button" onClick={() => setPanel(p)} className={`display rounded-full px-4 py-1.5 text-sm font-semibold uppercase ${panel === p ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>
                  {p === 'team' ? 'Mannschaft' : p === 'advanced' ? 'Spezial' : 'Spieltag & Automatik'}
                </button>
              ))}
              {panel !== 'auto' && (
                <Pill tone={load > 1.15 ? 'warn' : load < 0.9 ? 'good' : 'neutral'}>Fitnessbelastung ×{load.toLocaleString('de-DE')}</Pill>
              )}
            </div>

            {panel === 'team' && (
              <div className="grid gap-3 2xl:grid-cols-2">
                {(Object.keys(TEAM_SETTINGS) as TeamSettingKey[]).map((key) => {
                  const def = TEAM_SETTINGS[key];
                  return (
                    <div key={key}>
                      <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">{def.label}</div>
                      <Segmented
                        value={profile.team_instructions[key] as string | number}
                        values={def.values as readonly (string | number)[]}
                        labels={def.valueLabels}
                        onChange={(v) => update({ team_instructions: { ...profile.team_instructions, [key]: v } })}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {panel === 'advanced' && (
              <div className="grid gap-3 2xl:grid-cols-2">
                {(Object.keys(ADVANCED_OPTIONS) as AdvancedOptionKey[]).map((key) => {
                  const def = ADVANCED_OPTIONS[key];
                  return (
                    <div key={key}>
                      <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">{def.label}</div>
                      <Segmented
                        value={profile.advanced_options[key] as string | number | boolean}
                        values={def.values as readonly (string | number | boolean)[]}
                        labels={def.valueLabels}
                        onChange={(v) => update({ advanced_options: { ...profile.advanced_options, [key]: v } })}
                      />
                    </div>
                  );
                })}
                <p className="text-xs text-cream-dim 2xl:col-span-2">Pressing auf bestimmte Gegenspieler und individuelle Manndeckung legst du vor einer konkreten Partie fest, sobald der Gegner feststeht.</p>
              </div>
            )}

            {panel === 'auto' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">Startprofil für die nächste Partie</div>
                  <Segmented value={clubTactics.active_profile} values={TACTICAL_PROFILE_NAMES} labels={TACTICAL_PROFILE_NAMES.map((n) => PROFILE_LABEL[n])} onChange={(v) => setClubTactics({ ...clubTactics, active_profile: v })} />
                </div>
                <label className="flex items-center gap-3">
                  <input type="checkbox" checked={clubTactics.auto_substitutions} onChange={(e) => setClubTactics({ ...clubTactics, auto_substitutions: e.target.checked })} className="h-5 w-5 accent-[var(--color-gold)]" />
                  Automatische Auswechslungen
                </label>
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={clubTactics.auto_switch_enabled}
                    onChange={(e) =>
                      setClubTactics({
                        ...clubTactics,
                        auto_switch_enabled: e.target.checked,
                        auto_switch_minute: clubTactics.auto_switch_minute ?? 70,
                        auto_switch_when_trailing: clubTactics.auto_switch_when_trailing ?? 'offensive',
                        auto_switch_when_leading: clubTactics.auto_switch_when_leading ?? 'defensive',
                      })
                    }
                    className="h-5 w-5 accent-[var(--color-gold)]"
                  />
                  Automatischer Taktikwechsel
                </label>
                {clubTactics.auto_switch_enabled && (
                  <div className="space-y-3 rounded-xl bg-anthracite p-3">
                    <label className="block text-sm">
                      Ab Minute {clubTactics.auto_switch_minute}
                      <input type="range" min={1} max={89} value={clubTactics.auto_switch_minute ?? 70} onChange={(e) => setClubTactics({ ...clubTactics, auto_switch_minute: Number(e.target.value) })} className="mt-1 w-full accent-[var(--color-gold)]" />
                    </label>
                    <div>
                      <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">Bei Rückstand</div>
                      <Segmented value={clubTactics.auto_switch_when_trailing ?? 'offensive'} values={TACTICAL_PROFILE_NAMES} labels={TACTICAL_PROFILE_NAMES.map((n) => PROFILE_LABEL[n])} onChange={(v) => setClubTactics({ ...clubTactics, auto_switch_when_trailing: v })} />
                    </div>
                    <div>
                      <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">Bei Führung</div>
                      <Segmented value={clubTactics.auto_switch_when_leading ?? 'defensive'} values={TACTICAL_PROFILE_NAMES} labels={TACTICAL_PROFILE_NAMES.map((n) => PROFILE_LABEL[n])} onChange={(v) => setClubTactics({ ...clubTactics, auto_switch_when_leading: v })} />
                    </div>
                    <p className="text-xs text-cream-dim">Bei Gleichstand bleibt das aktuelle Profil. Manuelle Eingriffe während der Partie sind jederzeit möglich.</p>
                  </div>
                )}
                <Button onClick={() => void (async () => { setBusy('club'); setError(null); try { await onSaveClubTactics(); setNotice('Spieltag-Einstellungen gespeichert.'); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } })()} busy={busy === 'club'}>
                  Einstellungen speichern
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
