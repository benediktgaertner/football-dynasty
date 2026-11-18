# Datenbank

Supabase/PostgreSQL ≥ 15. Alle Änderungen erfolgen ausschließlich über Migrationen in `supabase/migrations`.

| Migration | Inhalt |
|---|---|
| `…0001_foundation` | Erweiterungen (`pgcrypto`, `unaccent`), Aufzählungstypen, Hilfsfunktionen (`normalize_name`, `stadium_build_cost`, `starting_capital`), globale Referenztabellen |
| `…0002_worlds_clubs_finance` | Profile, Karrierewelten, Mitglieder, Saisons, Vereine, Manager, Branding, Stadien, Konten, Buchungen (`post_transaction`), Sponsorenverträge, Bereitschaft |
| `…0003_players_market` | Spieler, verborgene Werte, Attribute, Entwicklung, Verträge, Draft, Transferfenster, Angebote, Transfers, Free Agents, Training, Verletzungen, Disziplin |
| `…0004_tactics` | Vereinstaktik, drei Profile je Verein, Positionen, individuelle Anweisungen, Standardschützen |
| `…0005_competitions_matches` | Wettbewerbe, Phasen, Gruppen, Teilnahmen, K.-o.-Paarungen, Auslosungen, Spielplan, Ergebnisse, Match-Sessions, Ereignisse, Spielerstatistiken, Tabellen, Auszeichnungen, Historie, Rekorde, Fünfjahreswertung, Startplätze, europäischer Status, Prämien |
| `…0006_security` | RLS-Policies, Tabellen- und Funktionsrechte |
| `…0007_rpc_lobby` | RPCs Phase 2 sowie Schutz vor massenhaften Beitrittsversuchen |
| `…0008_realtime` | Tabellen für Supabase Realtime |
| `…0010_phase3_draft` | Weltinitialisierung (`admin_start_draft`, nur Service-Role), Snake-Draft (`make_draft_pick`, `auto_pick_current`, `draft_state`), Reserve-Regel, Taktik-Grundausstattung |
| `…0009_reference_data` | **generiert** aus `packages/shared`: 55 Verbände, 30 Formationen, 30 Sponsorenangebote, 85 Prämienvorlagen, 336 Sperrnamen |

## Entitäten (Teil M)

Jede Entität aus Teil M ist abgebildet. Abweichende Namen:

* `users/profiles` → `auth.users` (Supabase) + `public.profiles`
* `tactics` → Vereinseinstellungen (aktives Profil, Automatik), `tactical_profiles` → die drei Profile
* `club_name_registry` → Unique-Constraints `clubs_name_unique` und `clubs_short_unique` auf normalisierten Namen sowie Tabelle `club_name_blocklist`
* `formations`, `associations`, `sponsor_offers` und `prize_templates` sind globale Referenzdaten. `competition_prize_schedules` kopiert sie je Saison, damit spätere Anpassungen am Balancing laufende Saisons nicht verändern.
* Zusätzlich gibt es `fixture_results`, getrennt von `fixtures`, damit Ergebnisse bis zur Freigabe per RLS verborgen bleiben. Ebenfalls neu: `player_hidden` (Potenzial), `competition_entries`, `association_strength_history` und `join_attempts`.

## Integritätsregeln (Auswahl)

| Regel | Umsetzung |
|---|---|
| Ein Verein je Manager und Welt | `clubs_one_per_manager` (partieller Unique-Index) |
| Ein Host je Welt | `world_members_one_host` |
| Eindeutige Vereinsnamen und Kurznamen je Welt | normalisiert (`normalize_name`, identisch zur TS-Funktion, Paritätstest) + Unique-Constraints |
| Reale Vereinsnamen nur nicht für KI | Trigger `clubs_normalize` mit `club_name_blocklist` |
| Spielerstammdaten nur einmal | `players.club_id` direkt am Spieler, keine Kopien je Verein |
| Ein aktiver Vertrag je Spieler | `player_contracts_one_active` |
| Kein Spieler doppelt gedraftet, kein Pick doppelt | `draft_picks unique(draft_id, player_id)`, `unique(draft_id, pick_index)` |
| Keine doppelten Buchungen | `financial_transactions unique(world_id, idempotency_key)` |
| Kein unerlaubt negatives Konto | `post_transaction(... p_allow_negative = false)` mit `FOR UPDATE` |
| Eine europäische Zuordnung je Verein und Saison | `club_season_european_status` PK (`season_id`, `club_id`) |
| Training: je Spieler eine Einheit pro Woche | `training_sessions unique(player_id, season_id, week_no)` |
| Tabellen konsistent | Checks `played = won + drawn + lost`, `points = 3·won + drawn` |
| Attribute vollständig, 1–99, keine fremden Schlüssel | `valid_attributes()` als CHECK |
| Wappen nur als geprüfte Konfiguration | `fd_valid_crest()` in `upsert_my_club` |

## RPCs (Phase 2)

| Funktion | Zweck |
|---|---|
| `set_username(p_username)` | Profil anlegen oder umbenennen (global eindeutig, normalisiert) |
| `create_world(p_name, p_difficulty)` | Welt + sicherer Einladungscode; Aufrufer wird Host |
| `join_world(p_code)` | Beitritt (idempotent, nur in der Lobby, max. 18 Manager, Begrenzung der Fehlversuche). Gibt `{world_id}` oder `{error, message}` zurück |
| `leave_world(p_world)` | Lobby verlassen (nicht für den Host) |
| `set_world_difficulty(p_world, p_difficulty)` | nur Host, nur Lobby; setzt die Bereitschaft aller zurück |
| `upsert_my_club(p_world, p_club)` | Verein gründen bzw. vor dem Draft bearbeiten: Name, Kurzname, Farben, Wappen, Trikot, Stadion. Legt Konto, Taktik und drei Profile an |
| `set_ready(p_world, p_ready)` | Bereitschaft (nur mit gegründetem Verein) |
| `touch_presence(p_world)` | Anwesenheit für die Timeout-Regeln |
| `lobby_state(p_world)` | vollständiger Lobby-Zustand inklusive Startkapital und Stadionkosten |
| `my_worlds()` | eigene Welten |

Fehler liefern im Feld `hint` einen maschinenlesbaren Code (z. B. `club_name_taken`) und eine deutsche Meldung.

**Startkapital und Stadionkosten** werden erst beim Draft-Start gebucht (Phase 3). Bis dahin darf der Host die Schwierigkeit noch ändern, und I3 verlangt den Abzug ohnehin erst „vor dem Draft“. Die Lobby zeigt das daraus folgende Draft-Budget schon vorher an.

## RPCs (Phase 3)

| Funktion | Zweck |
|---|---|
| `admin_start_draft(p_world, p_user, p_payload)` | nur `service_role`: prüft Host, Bereitschaft und Payload (54 − Menschen KI-Vereine, 18 je Liga, genau 400 Pool-Spieler ≤ 83, gültiges Branding). Speichert Saison, drei Ligen, Vereine, Kader, Verträge, Free Agents, Startkapital, Stadionkosten und Draft in **einer** Transaktion. Ein zweiter Aufruf bleibt wirkungslos |
| `make_draft_pick(p_world, p_player)` | Sperrt die Draft-Zeile (`FOR UPDATE`), prüft Reihenfolge (`fd_snake_index`), Verfügbarkeit, Budget und Reserve. Bucht den Marktwert, vergibt die Trikotnummer, legt einen 3-Jahres-Vertrag und einen Transfer an und schließt den Draft nach dem letzten Pick ab (Welt → `preseason`) |
| `auto_pick_current(p_world)` | Host wählt für einen Manager, der seit mindestens 15 Minuten abwesend ist: Positionsgruppe mit dem größten Bedarf, budgetbewusst |
| `draft_state(p_world)` | Reihenfolge, Verein am Zug, nächste 12 Picks, Budgets, alle Picks |

**Reserve-Regel:** Für jeden künftigen eigenen Pick wird angenommen, dass die anderen Vereine vorher die billigsten Spieler nehmen. Ein Kauf ist nur erlaubt, wenn danach genug Geld für diesen ungünstigsten Fall bleibt. Der günstigste verfügbare Spieler ist immer erlaubt. Reicht das Geld nicht einmal dafür (nur bei sehr vielen Managern auf „Schwer“ denkbar), wird er trotzdem verpflichtet und der Fehlbetrag als Minus gebucht, damit jeder Kader genau 22 Spieler hat (D3).
