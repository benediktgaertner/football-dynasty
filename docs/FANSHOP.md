# Fanshop und Kreditzinsen (Migration 0047)

**Ort:** Finanzen & Stadion, unter dem Finanzdashboard (kein eigener Menüpunkt).

## Fanshop
- Produkte: Heim-, Auswärts-, Sondertrikot, Schal, Cap, Fahne (`merch_products`). Preis je Produkt frei zwischen 40 % und 300 % des Basispreises, während eines laufenden Spieltags gesperrt.
- Nachfrage je Spieltermin (serverseitig, `fd_slot_economy`, ausgelöst beim Freigeben des Termins, idempotent):
  Käuferbasis (Heim: Zuschauer + Fernkäufer nach Stadiongröße/Ruf; Auswärts: Fernfans + mitgereiste) × Produktquote × Ruf × Tabellenplatz (0,75–1,25) × Preiselastizität `(Basispreis/Preis)^1,8` × leichte deterministische Streuung; Sondertrikot +60 % in Pokal und Europa.
- Verkauf nur aus dem Lager. Einkauf wird sofort bezahlt (`merch_order`, nur mit Kontodeckung); optional Auto-Nachbestellung auf Zielbestand. Lagerkosten je Termin (0,2 % des Lagerwerts).
- Menschen-Vereine starten mit 400 Stück je Produkt; KI-Vereine kaufen bedarfsgerecht, erzielen dieselben Erlöse, bekommen aber keine Historie (Kosten).
- Größenordnung: ca. 10–15 % der Ticketeinnahmen eines Spiels, kein unbegrenzter Geldhahn (Marge nach Einkauf und Lager).
- Dashboard: Umsatz/Gewinn Saison, Ø Marge, Bestseller, Lager mit Nachbestell-Hinweis, Umsatz je Spieltermin.

## Kreditzinsen
- Negativer Kontostand bleibt erlaubt (Gehälter), wird aber je Ligaspieltag verzinst: Jahreszins gestaffelt 6 % (bis 10 Mio.), 11 % (bis 50 Mio.), 18 % darüber, geteilt durch die Zahl der Ligatermine.
- Buchung `loan_interest` (Schlüssel `interest:<slot>:<club>`), sichtbar im Finanzdashboard (Gruppe „Kreditzinsen“) und als Hinweis im Fanshop-Bereich. Transfers/Einkäufe bleiben ohne Guthaben gesperrt.

## Auslieferung
SQL: `supabase/migrations/20261210000047_finance_merch_interest.sql` im Supabase-SQL-Editor ausführen. Kein Fly-Deploy nötig.
Tests: `supabase/tests/G10_merch_interest.sql`, `apps/web/e2e/clubpage/fanshop.spec.ts`, `financeReport.test.ts`.
