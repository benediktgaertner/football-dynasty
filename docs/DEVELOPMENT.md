# Spielerentwicklung & Spieltagssteuerung

## 1. Spieltagssteuerung (Migration 0022)

**Problem:** KI-gegen-KI-Partien wurden nur berechnet, wenn ein Browser den Match-Server anstieß
(`/world/simulate`). Brach eine Berechnung ab (Fly-Neustart/Deploy, Speicherfehler), stand die Partie
auf „live“ und wurde erst nach 6 Minuten – und nur bei erneutem Anstoß durch einen Client – wieder versucht.

**Lösung:**

| Baustein | Aufgabe |
|---|---|
| Sweep im Match-Server (alle 10 s, `SWEEP_INTERVAL_MS`) | findet über `admin_due_worlds` selbst alle Welten mit laufendem Spieltag – kein Client nötig |
| `admin_sweep_world` | holt die Freigabe nach, liefert offene Partien, erledigt KI-Training und Alterung in Häppchen |
| `fixture_jobs` | eindeutiger Verarbeitungsstatus: `queued → processing → done`, bei Fehler `failed` (sofort neu), nach 3 Fehlversuchen `fallback` |
| `admin_claim_fixture` | Sperre (Lease 4 min): dieselbe Partie wird nie parallel simuliert, auch nicht von zwei Instanzen |
| `admin_fallback_result` | letzte Sicherung: deterministisches Ergebnis aus Seed und Stärke – keine Partie blockiert je die Karriere |
| `admin_finish_match` | unverändert idempotent: gespeicherte Ergebnisse werden nie überschrieben |

Ergebnisse bleiben bis zur gemeinsamen Freigabe verborgen (`finished` ≠ `released`, RLS unverändert).
Ein reiner KI-Spieltag wird automatisch freigegeben (Sweep → `fd_try_release`).

## 2. Spielerentwicklung (Migration 0023)

Referenzmodell: `packages/shared/src/rules/development.ts`; serverseitig identisch in SQL (`fd_dev_*`).
Paritätstests vergleichen OVR, Marktwert, Faktoren und Spiel-XP zwischen TypeScript und SQL.

### XP-Quellen
* **Zusatztraining:** 1,6 XP × Multiplikator, verteilt nach Schwerpunkt × Positionsrelevanz.
* **Pflichtspiele:** `Minutenanteil × (0,25 + 1,2 × max(0, Note − 6))` auf die positionsrelevanten Attribute,
  dazu Tore → Schießen (0,6), Vorlagen → Passen (0,5), gewonnene Zweikämpfe → Verteidigung (0,08),
  Ballgewinne → Spielintelligenz (0,08), Paraden → Reflexe/Stellungsspiel/Fangen (0,15). Testspiele zählen nicht.

### Multiplikator (für alle Vereine gleich, keine KI-Boni)
* Alter: ≤19 ×1,6 · ≤21 ×1,4 · ≤23 ×1,2 · ≤26 ×1,0 · ≤29 ×0,6 · ≤32 ×0,3 · darüber ×0,15
* Potenzial (verborgen): ≥5 Punkte Luft ×1, 1–4 Punkte ×0,52–0,88, am Limit ×0,1
* Spielintelligenz: ×0,8 … ×1,15

### Umwandlung
Ein Attribut steigt um 1, sobald seine XP `3 + max(0, Wert − 50) × 0,1` erreichen (Wert 70: 5 XP, 90: 7 XP).
Danach werden OVR und Marktwert sofort neu berechnet; die Match Engine liest dieselben Attribute.
In der Saison sinkt die OVR nie (G5).

### Doppelvergabe ausgeschlossen
`match_player_stats.dev_xp` und `training_sessions.dev_xp` werden in derselben Transaktion gesetzt wie die
XP-Gutschrift; ein erneuter Aufruf findet nichts mehr. `admin_finish_match` lehnt doppelte Ergebnisse ab.

### KI-Vereine
Jede Woche wählt die KI bis zu 5 Spieler (Fitness ≥ 80, nicht verletzt), die am meisten profitieren
(Multiplikator), mit positionspassendem Schwerpunkt. Gleiche Regeln: 1 Einheit je Spieler, −20 Fitness.

### Alterung (nur beim Saisonwechsel)
Basisverlust je Attribut: 29: 0,3 · 30: 0,6 · 31: 1,0 · 32: 1,4 · 33: 1,9 · 34: 2,4 · ab 35: 3 + 0,5/Jahr,
× individueller Faktor 0,5–1,5 × Attributgewicht (Tempo 1,7, Ausdauer 1,5, … Spielintelligenz/Mentalität 0,15).
Große Welten: 2.000 Spieler direkt im Saisonwechsel, der Rest innerhalb weniger Sekunden durch den Server-Sweep.

### Bericht
`player_season_development` je Spieler und Saison: OVR Beginn/Ende/nach Alterung, verbesserte und
verschlechterte Attribute, XP aus Training und Spielen. Ansicht: Menü „Entwicklung“, Vereinsprofil →
„Entwicklungsbericht“ (auch KI-Vereine), Spielerprofil → „Entwicklung“.

## 3. Kalibrierung (`node scripts/dev-calibrate.mjs`, je 400 Durchläufe)

| Spieler | Δ OVR in der Saison | Alterung | gesamt |
|---|---|---|---|
| 18 J., 66, Potenzial 84, Stammspieler, jede Woche Training | +5,4 | 0 | +5,4 |
| derselbe ohne Training | +2,0 | 0 | +2,0 |
| derselbe als Bankspieler (25 %), mit Training | +3,9 | 0 | +3,9 |
| 21 J., 72, Pot. 80, Stamm, Training | +3,5 | 0 | +3,5 |
| 25 J., 78, Pot. 80, Stamm, Training / ohne | +1,7 / +0,5 | 0 | |
| 27 J., 80 am Potenzial, Training | 0 | 0 | 0 |
| 31 J., 79 / 33 J., 77 | 0 | −1,1 / −1,6 | |

Je Pflichtspiel gewinnt selbst ein Toptalent nur ~0,05–0,1 OVR – nach wenigen Spielen gibt es also keine Sprünge.
Ligaweit (18 Teams, 5 Saisons, alle Vereine trainieren): Ø Top-11-Stärke bleibt stabil (80,2 → 80,6 → 80,2);
ohne Nachwuchs altern die Kader langsam (Nachwuchs/Regens: geplante Phase).

Laufzeiten (volle Europa-Welt, 782 Vereine, 17.815 Spieler): KI-Training 0,2 s je 40 Vereine,
Saisonbilanz 0,7 s, Alterung 2 s (in Häppchen), Sweep 0,17 s.
