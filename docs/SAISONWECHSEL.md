# Saisonwechsel in Schritten (Migration 0048)

**Problem:** Der Saisonwechsel lief in einem einzigen Aufruf des Spielers (PostgREST-Limit 8 s) und brach bei großen Welten mit „canceling statement due to statement timeout“ ab.

**Lösung:**
- Klick auf „Bereit für den Termin“ beim Termin *Saisonende* legt nur noch einen Auftrag an (`season_end_jobs`) und kehrt sofort zurück.
- Der Match-Server (Sweep, `service_role`, 60 s je Aufruf) arbeitet den Auftrag in 7 Schritten ab, jeder Schritt eine eigene Transaktion. `admin_sweep_world` meldet „noch Arbeit“, der Server ruft sofort wieder auf. **Kein Fly-Deploy nötig** (Logik liegt in der DB).
  1. Auf-/Abstieg, Sponsor-Prämien, neue Saison und Ligen
  2. Entwicklungsbericht (`fd_dev_season_close`)
  3. Vertragsmanagement (`fd_contracts_season_change`, Rückfall +2 Jahre)
  4. Alter +1, Alterung, Sperren, Fitness
  5. Wechsel in die neue Saison
  6. Jugend und Karriereende (Trigger-Flag `fd.defer_youth`)
  7. Ergänzungsspieler entfernen, Kader reduzieren
- Die Oberfläche zeigt Fortschritt („Schritt x von 7“). Nach 5 Fehlversuchen eines Schritts stoppt der Server; der Host kann im Spieltagsbereich „Erneut versuchen“ wählen.
- Direkte Aufrufe (SQL-Editor, Tests) laufen weiter in einem Zug (`fd_end_season`).

**Hängende Welt retten:** Nach dem Einspielen der Migration genügt es, in der App erneut „Bereit für den Termin“ zu klicken (der Match-Server muss laufen).
Tests: `supabase/tests/G11_season_end_steps.sql`.
