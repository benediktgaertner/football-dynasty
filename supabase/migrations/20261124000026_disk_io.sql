-- Disk-IO entlasten: doppelte Indizes auf players entfernen.
-- Jede Änderung an players (Fitness, Stärke, Marktwert) musste jeden dieser Indizes mitschreiben.
-- players_club_id_idx ist identisch mit players_club_idx (0003).
drop index if exists public.players_club_id_idx;
-- players_world_pos_ovr deckt sich mit players_world_pos_overall_idx (0015, nur aktive Spieler);
-- Abfragen auf Positionsgruppen filtern ohnehin auf "not retired".
drop index if exists public.players_world_pos_ovr;
