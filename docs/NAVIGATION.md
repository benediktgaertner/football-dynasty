# Hauptmenü (Karrierewelt)

Sechs Hauptpunkte statt zwölf (`apps/web/src/lib/nav.ts`, Komponente `WorldNav`):

| Hauptpunkt | Inhalt |
|---|---|
| **Dashboard** (direkt) | Spieltag, Begegnungen, Übersichten |
| **Mannschaft ▾** | Team (Aufstellung, Taktik, Training) · Entwicklung · Jugend · Verträge |
| **Wettbewerbe ▾** | Liga · Pokal · Europa · Kalender |
| **Transfers** (direkt) | Transfermarkt, Free Agents, Angebote |
| **Verein ▾** | Finanzen & Stadion · Fankultur & Musik · Choreo-Designer |
| **Liga-Menü** (direkt) | Liga betreten, Einstellungen (Host) |

Der aktive Bereich ist hervorgehoben, auch bei Unterseiten (Spielerprofil → Mannschaft, Vereinsseite → Wettbewerbe, Übersicht → Dashboard, Einstellungen → Liga-Menü). Bedienung: Maus (Klick oder Hover), Touch (Tippen), Tastatur (Pfeiltasten, Esc). Menüs schließen per Klick daneben, Esc und Seitenwechsel; auf schmalen Fenstern bricht die Leiste um.
Neue Seiten: Eintrag in `NAV` ergänzen (Test `e2e/clubpage/nav.spec.ts` prüft, dass jedes Ziel erreichbar ist).
