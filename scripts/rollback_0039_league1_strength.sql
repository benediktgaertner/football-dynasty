-- Rückgängig: Migration 0039 (Erste Liga stärker) – im Supabase-SQL-Editor ausführen.
-- Schreibt für alle von der Datenmigration angepassten Spieler die gesicherten Originalwerte
-- (Attribute, Gesamtstärke, Marktwert, Potenzial aus fd_backup.league1_0039) exakt zurück,
-- entfernt die Migrationsmarker und schaltet die Verstärkung bei neuen Welten ab
-- (fd_settings league1_strength = off). Spielerentwicklung seit der Migration geht für diese Spieler verloren.
-- Bei der Generierung nach 0039 verstärkte Welten (Marker source = 'generation') haben keine Sicherung
-- und bleiben unverändert. Die Funktionen bleiben bestehen (wirkungslos, solange der Schalter aus ist).
--
-- Nur eine Welt: select public.fd_league1_strength_rollback('<world-uuid>');
-- Wieder anwenden: update public.fd_settings set value = 'on' where key = 'league1_strength';
--                  select public.fd_league1_strength_apply_all();

select public.fd_league1_strength_rollback(null);

-- Kontrolle: keine offene Sicherung mehr, Schalter aus
select count(*) filter (where restored_at is null) as offen, count(*) as gesamt from fd_backup.league1_0039;
select value as league1_strength from public.fd_settings where key = 'league1_strength';
