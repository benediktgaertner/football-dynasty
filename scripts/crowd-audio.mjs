#!/usr/bin/env node
/**
 * Stadionaufnahmen für die KI-Fans aufbereiten (lokal, ffmpeg nötig).
 *
 *   node scripts/crowd-audio.mjs                  # assets/crowd-raw → apps/web/public/audio/crowd
 *   node scripts/crowd-audio.mjs --check          # nur prüfen (Manifest + Dateien)
 *   node scripts/crowd-audio.mjs RAW OUT          # eigene Ordner
 *
 * Rohdateien:  assets/crowd-raw/<kategorie>/<name>.(wav|flac|mp3|ogg|m4a)
 * Lizenzangabe je Datei (Pflicht), entweder als <name>.json neben der Datei:
 *   { "credit": "paulw2k (freesound.org)", "license": "CC BY 4.0", "source": "https://freesound.org/s/196461/" }
 * oder gesammelt in assets/crowd-raw/sources.json: { "goal/brentford_goal.wav": { …wie oben… } }
 *
 * Kategorien: ambience clap attack chance whistle concede goal (keine Fangesänge – die kommen nur als Vereins-Upload)
 * Verarbeitung: Trittschall-Hochpass, Stille am Anfang entfernen, Länge begrenzen, Lautheit (EBU R128)
 * je Kategorie angleichen, True-Peak-Begrenzung (−1,5 dBTP), weiche Ein-/Ausblendung, MP3 44,1 kHz Stereo.
 * Ergebnis: <OUT>/<kategorie>/<name>.mp3, <OUT>/manifest.json, <OUT>/CREDITS.md (Namensnennung für CC BY).
 * Abgelehnt: Dateien ohne Lizenz, NC/ND-Lizenzen (Bearbeitung/Spiel), KI-generierte Quellen (z. B. ElevenLabs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const check = args.includes('--check');
const allowNc = args.includes('--allow-nc');
const pos = args.filter((a) => !a.startsWith('--'));
const RAW = resolve(pos[0] ?? join(root, 'assets/crowd-raw'));
const OUT = resolve(pos[1] ?? join(root, 'apps/web/public/audio/crowd'));

/** Kategorie → [min s, max s, Ziel-Lautheit LUFS, Ausblendung s, Mindestanzahl] (wie crowdLibrary.ts) */
const CATS = {
  ambience: [30, 240, -23, 3, 3],
  clap: [6, 30, -20, 0.8, 3],
  attack: [2, 8, -19, 0.5, 3],
  chance: [2, 5, -18, 0.6, 3],
  whistle: [2, 8, -21, 0.5, 3],
  concede: [2, 6, -22, 0.8, 2],
  goal: [4, 10, -16, 1, 3],
};
const AUDIO = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.aif', '.aiff']);

function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} nicht gefunden – bitte ffmpeg installieren (https://ffmpeg.org)`);
  return r;
}
function duration(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(r.stdout.trim());
}
function peakDb(file) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}
function licenseProblem(meta) {
  if (!meta || !meta.license || !meta.credit || !meta.source) return 'Lizenzangabe fehlt (credit, license, source)';
  const l = String(meta.license).toUpperCase();
  if (/(^|[^A-Z])ND([^A-Z]|$)/.test(l)) return `Lizenz ${meta.license} erlaubt keine Bearbeitung`;
  if (/(^|[^A-Z])NC([^A-Z]|$)/.test(l) && !allowNc) return `Lizenz ${meta.license} ist nicht-kommerziell (mit --allow-nc trotzdem verwenden)`;
  if (/\b(ELEVENLABS|SUNO|UDIO|AI[- ]GENERATED|KI[- ]GENERIERT)\b/i.test(`${meta.source} ${meta.credit} ${meta.license}`)) return 'KI-generierte Quelle – nicht erlaubt';
  return null;
}
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);

function validate(manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];
  const counts = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]));
  for (const f of m.files ?? []) {
    const p = join(OUT, f.file);
    if (!CATS[f.category]) problems.push(`${f.file}: unbekannte Kategorie ${f.category}`);
    if (!existsSync(p)) { problems.push(`${f.file}: Datei fehlt`); continue; }
    const lp = licenseProblem(f);
    if (lp) problems.push(`${f.file}: ${lp}`);
    const d = duration(p);
    if (Math.abs(d - f.duration) > 0.3) problems.push(`${f.file}: Dauer ${d.toFixed(1)} s ≠ Manifest ${f.duration}`);
    const pk = peakDb(p);
    if (pk > -0.5) problems.push(`${f.file}: Spitzenpegel ${pk} dB (Übersteuerungsgefahr)`);
    counts[f.category]++;
  }
  return { problems, counts };
}

function report(counts) {
  console.log('\nKategorie       Anzahl  Soll');
  for (const [k, [, , , , min]] of Object.entries(CATS)) {
    const n = counts[k] ?? 0;
    console.log(`${k.padEnd(15)} ${String(n).padStart(6)}  ${String(min).padStart(4)}  ${n === 0 ? 'FEHLT (bleibt stumm)' : n < min ? 'zu wenig Abwechslung' : 'ok'}`);
  }
}

if (check) {
  const mp = join(OUT, 'manifest.json');
  if (!existsSync(mp)) { console.error(`kein Manifest: ${mp}`); process.exit(1); }
  const { problems, counts } = validate(mp);
  report(counts);
  if (problems.length) { console.error('\nProbleme:\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log('\nManifest ok.');
  process.exit(0);
}

if (!existsSync(RAW)) {
  console.error(`Rohordner fehlt: ${RAW}\nLege die Aufnahmen unter <kategorie>/ ab (siehe Kopf dieser Datei).`);
  process.exit(1);
}
const shared = existsSync(join(RAW, 'sources.json')) ? JSON.parse(readFileSync(join(RAW, 'sources.json'), 'utf8')) : {};
const files = [];
const rejected = [];
for (const cat of Object.keys(CATS)) {
  const dir = join(RAW, cat);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  mkdirSync(join(OUT, cat), { recursive: true });
  for (const name of readdirSync(dir).sort()) {
    if (!AUDIO.has(extname(name).toLowerCase())) continue;
    const src = join(dir, name);
    const side = join(dir, basename(name, extname(name)) + '.json');
    const meta = existsSync(side) ? JSON.parse(readFileSync(side, 'utf8')) : shared[`${cat}/${name}`];
    const lp = licenseProblem(meta);
    if (lp) { rejected.push(`${cat}/${name}: ${lp}`); continue; }
    const [minS, maxS, lufs, fade] = CATS[cat];
    const inDur = duration(src);
    if (!(inDur >= minS * 0.6)) { rejected.push(`${cat}/${name}: zu kurz (${inDur.toFixed(1)} s, mind. ${minS} s)`); continue; }
    const id = `${cat}_${slug(basename(name, extname(name)))}`;
    const rel = `${cat}/${id}.mp3`;
    const dst = join(OUT, rel);
    const len = Math.min(maxS, inDur);
    // Ereignisse beginnen direkt mit der Reaktion: Stille am Anfang entfernen; lange Aufnahmen behalten ihren Einstieg
    const trimStart = cat === 'ambience' ? '' : 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,';
    const fadeIn = cat === 'goal' || cat === 'chance' ? 0.02 : Math.min(1, fade);
    const chain = (trim) => [
      'highpass=f=55',
      trim + `atrim=0:${len.toFixed(2)},asetpts=N/SR/TB`,
      `loudnorm=I=${lufs}:TP=-2:LRA=11`,
      'aresample=44100',
      `afade=t=in:st=0:d=${fadeIn}`,
      `areverse,afade=t=in:st=0:d=${fade},areverse`,
      'alimiter=limit=0.84:level=false',
    ].join(',');
    const enc = (af) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-af', af, '-ac', '2', '-c:a', 'libmp3lame', '-q:a', cat === 'ambience' ? '4' : '3', dst]);
    let r = enc(chain(trimStart));
    // leise Aufnahme: Stilleerkennung hätte zu viel entfernt ⇒ ohne Kürzung am Anfang
    if (r.status === 0 && trimStart && !(duration(dst) >= Math.min(len, minS) * 0.6)) r = enc(chain(''));
    if (r.status !== 0) { rejected.push(`${cat}/${name}: ffmpeg-Fehler ${r.stderr.trim().slice(0, 200)}`); continue; }
    const d = Math.round(duration(dst) * 100) / 100;
    files.push({ id, category: cat, file: rel, duration: d, gain: 1, credit: meta.credit, license: meta.license, source: meta.source });
    console.log(`✓ ${rel}  ${d.toFixed(1)} s  ${meta.license}`);
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ version: 1, generated: new Date().toISOString(), files }, null, 2) + '\n');
const credits = ['# Stadionaufnahmen – Quellen und Lizenzen', '', 'Diese Aufnahmen werden für die Stadionatmosphäre der KI-Fans verwendet (bearbeitet: geschnitten, Lautheit angeglichen).', '',
  ...files.map((f) => `- \`${f.file}\` – ${f.credit}, ${f.license}, ${f.source}`), ''];
writeFileSync(join(OUT, 'CREDITS.md'), credits.join('\n'));
const { problems, counts } = validate(join(OUT, 'manifest.json'));
report(counts);
if (rejected.length) console.warn('\nNicht übernommen:\n- ' + rejected.join('\n- '));
if (problems.length) { console.error('\nProbleme:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`\n${files.length} Aufnahmen → ${relative(root, OUT)}/manifest.json`);
