-- V2 — Migración 020: nombre del club configurable
-- El nombre de la sede/club deja de estar hardcodeado ("Club BOA"); el admin lo
-- edita desde el panel Configuración v2. La UI (login, reglamento) e invitaciones
-- lo leen de acá. Default = 'Club BOA' para preservar el valor actual.

ALTER TABLE v2_config
  ADD COLUMN IF NOT EXISTS nombre_club text NOT NULL DEFAULT 'Club BOA';
