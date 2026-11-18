import {
  CREST_PATTERNS,
  CREST_SHAPES,
  CREST_SYMBOLS,
  KIT_PATTERNS,
  STADIUM_CAPACITY_STEP,
  STADIUM_MAX_CAPACITY,
  STADIUM_MIN_CAPACITY,
  clubCreationSchema,
  contrastRatio,
  createRng,
  randomCrest,
  stadiumBuildCost,
  type ClubCreationInput,
  type CrestConfig,
} from '@fd/shared';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatEuro, type LobbyState } from '../lib/api';
import { Crest } from '../components/Crest';
import { KitPreview } from '../components/KitPreview';
import { Button, Card, ErrorBanner, Field, Shell, Spinner, TextInput } from '../components/ui';

const SHAPE_LABEL: Record<CrestConfig['shape'], string> = { shield: 'Schild', classic: 'Klassisch', round: 'Rund', diamond: 'Raute', hexagon: 'Sechseck', banner: 'Banner' };
const PATTERN_LABEL: Record<CrestConfig['pattern'], string> = { solid: 'Einfarbig', halves: 'Geteilt', stripes: 'Streifen', hoops: 'Ringe', sash: 'Schärpe', quarters: 'Geviert', chevron: 'Sparren' };
const SYMBOL_LABEL: Record<CrestConfig['symbol'], string> = { none: 'Keins', ball: 'Ball', lion: 'Löwe', eagle: 'Adler', crown: 'Krone', star: 'Stern', lightning: 'Blitz' };
const KIT_LABEL: Record<(typeof KIT_PATTERNS)[number], string> = { solid: 'Uni', stripes: 'Streifen', hoops: 'Ringel', halves: 'Halbiert', sash: 'Schärpe' };

const STEPS = ['Name', 'Farben', 'Wappen', 'Trikot', 'Stadion'] as const;

function initialsFrom(short: string): string {
  return short.toUpperCase().replace(/[^A-ZÄÖÜ0-9.&]/gu, '').slice(0, 4) || 'FC';
}

const DEFAULT: ClubCreationInput = {
  name: '',
  shortName: '',
  primaryColor: '#2F6B3A',
  secondaryColor: '#F4EBD0',
  accentColor: '#F2C14E',
  crest: { shape: 'shield', pattern: 'halves', symbol: 'ball', primary: '#2F6B3A', secondary: '#F4EBD0', accent: '#F2C14E', borderWidth: 3, initials: 'FC', foundedYear: null },
  kit: { pattern: 'solid', primary: '#2F6B3A', secondary: '#F4EBD0' },
  stadiumName: '',
  stadiumCapacity: 20_000,
};

/** B2.3–B2.8 und B3: Vereinsgründung mit integriertem Wappen-Editor. */
export function ClubEditor() {
  const { worldId = '' } = useParams();
  const navigate = useNavigate();
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [club, setClub] = useState<ClubCreationInput>(DEFAULT);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [crestLinked, setCrestLinked] = useState(true);

  useEffect(() => {
    api.lobbyState(worldId).then((s) => {
      setLobby(s);
      const mine = s.members.find((m) => m.user_id === s.me.user_id)?.club;
      if (mine) {
        setClub({
          name: mine.name,
          shortName: mine.short_name,
          primaryColor: mine.primary_color,
          secondaryColor: mine.secondary_color,
          accentColor: mine.accent_color,
          crest: mine.crest,
          kit: mine.kit,
          stadiumName: mine.stadium_name,
          stadiumCapacity: mine.stadium_capacity,
        });
        setCrestLinked(false);
      }
    }, (e: Error) => setError(e.message));
  }, [worldId]);

  const set = <K extends keyof ClubCreationInput>(key: K, value: ClubCreationInput[K]) => setClub((c) => ({ ...c, [key]: value }));
  const setCrest = (patch: Partial<CrestConfig>) => setClub((c) => ({ ...c, crest: { ...c.crest, ...patch } }));

  // Vereinsfarben auf Wappen und Trikot übertragen, solange der Manager sie dort nicht einzeln ändert
  function setColor(key: 'primaryColor' | 'secondaryColor' | 'accentColor', value: string) {
    setClub((c) => {
      const next = { ...c, [key]: value };
      if (crestLinked) {
        next.crest = { ...c.crest, primary: next.primaryColor, secondary: next.secondaryColor, accent: next.accentColor };
        next.kit = { ...c.kit, primary: next.primaryColor, secondary: next.secondaryColor };
      }
      return next;
    });
  }

  const validation = useMemo(() => clubCreationSchema.safeParse(club), [club]);
  const issues = useMemo(() => {
    const map: Record<string, string> = {};
    if (!validation.success) for (const i of validation.error.issues) map[String(i.path[0])] ??= i.message;
    return map;
  }, [validation]);

  const stadiumCost = stadiumBuildCost(club.stadiumCapacity);
  const capital = lobby?.world.starting_capital ?? 0;
  const lowContrast = contrastRatio(club.primaryColor, club.secondaryColor) < 1.6;

  async function save() {
    setError(null);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? 'Bitte prüfe deine Eingaben.');
      return;
    }
    setSaving(true);
    try {
      await api.upsertMyClub(worldId, validation.data);
      navigate(`/w/${worldId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!lobby) return <Shell>{error ? <ErrorBanner error={error} /> : <Spinner />}</Shell>;

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <nav className="mb-6 flex flex-wrap gap-2" aria-label="Schritte">
            {STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setStep(i)}
                className={`display rounded-full px-4 py-1.5 text-base font-semibold uppercase tracking-wider transition ${i === step ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}
              >
                {i + 1}. {s}
              </button>
            ))}
          </nav>

          {step === 0 && (
            <div className="space-y-5">
              <Field label="Vereinsname" error={club.name ? issues.name : null} hint="3–32 Zeichen, z. B. „SV Grünwald 1911“">
                <TextInput value={club.name} maxLength={32} onChange={(e) => set('name', e.target.value)} autoFocus />
              </Field>
              <Field label="Kurzname" error={club.shortName ? issues.shortName : null} hint="3–4 Zeichen für Tabellen und Spielstand">
                <TextInput
                  value={club.shortName}
                  maxLength={4}
                  className="display uppercase tracking-[0.3em]"
                  onChange={(e) => {
                    const v = e.target.value.toUpperCase();
                    set('shortName', v);
                    if (crestLinked) setCrest({ initials: initialsFrom(v) });
                  }}
                />
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              {(
                [
                  ['primaryColor', 'Primärfarbe'],
                  ['secondaryColor', 'Sekundärfarbe'],
                  ['accentColor', 'Akzentfarbe'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <div className="flex items-center gap-3">
                    <input type="color" value={club[key]} onChange={(e) => setColor(key, e.target.value.toUpperCase())} className="h-12 w-16 cursor-pointer rounded-lg border border-olive-600 bg-transparent" />
                    <TextInput value={club[key]} maxLength={7} onChange={(e) => setColor(key, e.target.value.toUpperCase())} className="display max-w-40 uppercase" />
                  </div>
                </Field>
              ))}
              {lowContrast && <p className="text-sm text-sunset">Primär- und Sekundärfarbe sind sehr ähnlich. Muster auf Wappen und Trikot sind dann kaum erkennbar.</p>}
              <label className="flex items-center gap-3 text-cream-dim">
                <input type="checkbox" checked={crestLinked} onChange={(e) => setCrestLinked(e.target.checked)} className="h-5 w-5 accent-[var(--color-gold)]" />
                Farben automatisch auf Wappen und Trikot übernehmen
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <ChoiceRow label="Form" options={CREST_SHAPES} labels={SHAPE_LABEL} value={club.crest.shape} onChange={(v) => setCrest({ shape: v })} />
              <ChoiceRow label="Muster" options={CREST_PATTERNS} labels={PATTERN_LABEL} value={club.crest.pattern} onChange={(v) => setCrest({ pattern: v })} />
              <ChoiceRow label="Symbol" options={CREST_SYMBOLS} labels={SYMBOL_LABEL} value={club.crest.symbol} onChange={(v) => setCrest({ symbol: v })} />
              <div className="grid gap-4 sm:grid-cols-3">
                {(['primary', 'secondary', 'accent'] as const).map((k) => (
                  <Field key={k} label={{ primary: 'Hintergrund', secondary: 'Muster', accent: 'Symbol & Rahmen' }[k]}>
                    <input
                      type="color"
                      value={club.crest[k]}
                      onChange={(e) => {
                        setCrestLinked(false);
                        setCrest({ [k]: e.target.value.toUpperCase() });
                      }}
                      className="h-12 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent"
                    />
                  </Field>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Initialen" error={issues.crest}>
                  <TextInput value={club.crest.initials} maxLength={4} className="display uppercase tracking-widest" onChange={(e) => setCrest({ initials: e.target.value.toUpperCase() })} />
                </Field>
                <Field label="Gründungsjahr" hint="optional">
                  <TextInput
                    type="number"
                    min={1850}
                    max={2100}
                    value={club.crest.foundedYear ?? ''}
                    onChange={(e) => setCrest({ foundedYear: e.target.value === '' ? null : Number(e.target.value) })}
                  />
                </Field>
                <Field label={`Rahmen: ${club.crest.borderWidth}`}>
                  <input type="range" min={0} max={6} value={club.crest.borderWidth} onChange={(e) => setCrest({ borderWidth: Number(e.target.value) })} className="mt-3 w-full accent-[var(--color-gold)]" />
                </Field>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  const rng = createRng(`${Date.now()}-${Math.random()}`);
                  setCrestLinked(false);
                  set('crest', randomCrest(() => rng.next(), initialsFrom(club.shortName)));
                }}
              >
                Zufallswappen
              </Button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <ChoiceRow label="Trikotdesign" options={KIT_PATTERNS} labels={KIT_LABEL} value={club.kit.pattern} onChange={(v) => set('kit', { ...club.kit, pattern: v })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Trikotfarbe">
                  <input type="color" value={club.kit.primary} onChange={(e) => set('kit', { ...club.kit, primary: e.target.value.toUpperCase() })} className="h-12 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent" />
                </Field>
                <Field label="Musterfarbe">
                  <input type="color" value={club.kit.secondary} onChange={(e) => set('kit', { ...club.kit, secondary: e.target.value.toUpperCase() })} className="h-12 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent" />
                </Field>
              </div>
              <KitPreview kit={club.kit} />
              <p className="text-sm text-cream-dim">Die Trikotnummer wird automatisch hell oder dunkel gesetzt, damit sie immer lesbar bleibt. Bei ähnlichen Farben beider Teams wählt die Match Engine eine Ausweichfarbe.</p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5">
              <Field label="Stadionname" error={club.stadiumName ? issues.stadiumName : null}>
                <TextInput value={club.stadiumName} maxLength={40} onChange={(e) => set('stadiumName', e.target.value)} placeholder="z. B. Arena am Flussufer" />
              </Field>
              <Field label={`Kapazität: ${club.stadiumCapacity.toLocaleString('de-DE')} Plätze`} hint="Ausbau später nur zum Saisonwechsel: 25 Mio. € je 5.000 Plätze.">
                <input
                  type="range"
                  min={STADIUM_MIN_CAPACITY}
                  max={STADIUM_MAX_CAPACITY}
                  step={STADIUM_CAPACITY_STEP}
                  value={club.stadiumCapacity}
                  onChange={(e) => set('stadiumCapacity', Number(e.target.value))}
                  className="mt-3 w-full accent-[var(--color-gold)]"
                />
              </Field>
              <dl className="grid grid-cols-3 gap-3 rounded-xl bg-anthracite p-4 text-center">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-cream-dim">Baukosten</dt>
                  <dd className="display text-2xl font-bold text-sunset">{formatEuro(stadiumCost)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-cream-dim">je Platz</dt>
                  <dd className="display text-2xl font-bold">{Math.round(stadiumCost / club.stadiumCapacity).toLocaleString('de-DE')} €</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-cream-dim">Draft-Budget</dt>
                  <dd className="display text-2xl font-bold text-gold">{formatEuro(capital - stadiumCost)}</dd>
                </div>
              </dl>
              <p className="text-sm text-cream-dim">
                Größere Stadien bringen mehr Ticketeinnahmen und bei hoher Auslastung einen stärkeren Heimvorteil, kosten aber Draft-Budget.
              </p>
            </div>
          )}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-olive-700 pt-5">
            <Button variant="ghost" onClick={() => (step === 0 ? navigate(`/w/${worldId}`) : setStep(step - 1))}>
              {step === 0 ? 'Abbrechen' : 'Zurück'}
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep(step + 1)}>Weiter</Button>
            ) : (
              <Button onClick={() => void save()} busy={saving} disabled={!validation.success}>
                Verein speichern
              </Button>
            )}
          </div>
          <div className="mt-4">
            <ErrorBanner error={error} />
          </div>
        </Card>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <Card className="pitch-stripes flex flex-col items-center text-center">
            <Crest crest={club.crest} size={170} />
            <div className="display mt-4 text-3xl font-extrabold uppercase leading-tight">{club.name || 'Dein Verein'}</div>
            <div className="display text-xl tracking-[0.3em] text-gold">{club.shortName || '···'}</div>
            <div className="mt-3 flex gap-2">
              {[club.primaryColor, club.secondaryColor, club.accentColor].map((c, i) => (
                <span key={i} className="h-6 w-6 rounded-full border-2 border-ink" style={{ background: c }} />
              ))}
            </div>
            <div className="mt-4 text-sm text-cream-dim">
              {club.stadiumName || 'Stadion'} · {club.stadiumCapacity.toLocaleString('de-DE')} Plätze
            </div>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}

function ChoiceRow<T extends string>({ label, options, labels, value, onChange }: { label: string; options: readonly T[]; labels: Record<T, string>; value: T; onChange: (v: T) => void }) {
  return (
    <div>
      <span className="display mb-2 block text-sm font-semibold uppercase tracking-wider text-cream-dim">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            onClick={() => onChange(o)}
            className={`min-h-11 rounded-xl border px-4 transition ${o === value ? 'border-gold bg-gold/10 text-cream' : 'border-olive-600 text-cream-dim hover:border-gold/60'}`}
          >
            {labels[o]}
          </button>
        ))}
      </div>
    </div>
  );
}
