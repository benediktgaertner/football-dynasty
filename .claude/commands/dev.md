---
description: Entwicklungsauftrag im kontrollierten Build-Test-Fix-Loop (Plan → Umsetzung → Prüfung)
argument-hint: <Auftrag>
---
Auftrag: $ARGUMENTS

Arbeite nach CLAUDE.md („Entwicklungsloop“), knapp und creditsparend:
1. Akzeptanzkriterien aus dem Auftrag ableiten (max. 6 Punkte) und in kleine Schritte zerlegen (TaskCreate).
2. Komplex (Engine, Multiplayer, DB/RLS/Migration, Architektur)? → einmal `architect` für den Plan. Sonst direkt.
3. Unklar, wo etwas liegt? → `explorer` (Haiku). Umsetzung → `developer` (Sonnet) oder selbst bei Kleinigkeiten.
4. Nach jedem Schritt: `node .claude/hooks/check.mjs <dateien>`; SQL → `bash scripts/test-db.sh`; UI/Match/Audio/Login → passender Playwright-Test über `tester`.
5. Fehler: höchstens 3 gezielte Korrekturen, dann Befund dokumentieren und `architect` fragen.
6. Fertig, wenn alle Kriterien ✓. Kein Deploy/Push, keine Produktivdaten. Ergebnis: Dateien, Prüfungen, Deploy-Schritte (eine SQL + eine Zip).
