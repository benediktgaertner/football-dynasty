# Stadion bis 80.000, Zuschauer und Ausbauökonomie (Migration 0049)

- **Kapazität:** 10.000–80.000 in 5.000er-Schritten. Neubau beim Vereinsstart weiterhin bis 50.000, größere Arenen entstehen durch Ausbau. Bestehende Stadien bleiben unverändert.
- **Optik:** bis 20.000 ein Rang, bis 40.000 zwei, bis 60.000 drei, darüber ein vierter Zusatzrang; Tribünen werden tiefer (80.000 ≈ 15 m). Für Choreografien zählt der Zusatzrang zum Oberrang.
- **Zuschauer:** absolute Nachfrage (`fd_stadium_demand`: Spielklasse, Ruf, Ticketpreis, Tabellenform, Gegner, Spielbedeutung) statt fester Quote; Zuschauer = Nachfrage, sanft begrenzt ab 85 % Auslastung. Ein größeres Stadion bringt nur mehr Zuschauer, wenn die Nachfrage es füllt.
- **Ausbaukosten je 5.000 Plätze:** 3,2 Mio. € + 30 € je vorhandenem Platz (30.000 → 4,1 Mio., 75.000 → 5,45 Mio.), mit Wirtschaftsfaktor der Welt skaliert.
- **Betrieb:** Stadionkosten je Heimspiel 2 € je Platz, darüber progressiv (80.000 ≈ 5 €/Platz). Neu: Gastronomie-Einnahmen (28 % des Ticketpreises je Zuschauer, `catering_income`, im Dashboard unter „Tickets & Gastronomie“). Fanshop-Käuferbasis hängt jetzt an den echten Zuschauern.
- **Prognose vor dem Ausbau** (`stadium_expansion_quote`): Zuschauer vorher/nachher, Tickets, Gastronomie, Fanshop, Betrieb, Netto je Jahr, Break-even in Jahren und Einordnung („im Laufe der zweiten Saison“ …).
- **Kalibrierung (Tests G12):** ausgelastete Ausbauten (Ticketpreis 25 €) amortisieren sich nach 1,2–2,0 Saisons, nie in der ersten; Ausbau über die Nachfrage hinaus gilt als „wirtschaftlich nicht sinnvoll“. Die Faustwerte aus dem Auftrag (25 Mio. → 7,5–9 Mio.) wurden nicht übernommen, weil der Mehrertrag der Spielökonomie nur ca. 1,5–3 Mio. € je 5.000 Plätze und Jahr beträgt; die Kosten sind daran skaliert.
- **Heimvorteil:** Größenanteil begrenzt (höchstens das 1,25-fache eines 50.000er-Stadions, Gesamtdeckel 4 %).
Tests: `supabase/tests/G12_stadium_economy.sql`, `apps/web/e2e/clubpage/stadium-expansion.spec.ts`, `stadiumArt.test.ts`, `rules.test.ts`.
