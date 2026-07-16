-- V2 — Rango máximo de desafío configurable (regla 3)
-- Cambio de reglamento: el alcance máximo pasa de 5 a 4 puestos hacia arriba.
-- La validación al crear un desafío debe leer este valor (no un número fijo).
-- El WildCard queda exento de este límite.

ALTER TABLE v2_config
  ADD COLUMN IF NOT EXISTS max_puestos_desafio integer NOT NULL DEFAULT 4;
