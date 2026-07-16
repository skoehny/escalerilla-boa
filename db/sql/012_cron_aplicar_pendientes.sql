-- V2 — Migración 012: cron de seguridad (pg_cron)
-- Red de seguridad: cada 5 minutos aplica al ranking los resultados que hayan
-- quedado sin aplicar (p. ej. si el guardado en la UI no alcanzó a llamar
-- aplicar_resultado, o resultados creados por otras vías). aplicar_pendientes()
-- solo toca los que están validados o con la ventana de validación ya vencida,
-- y nunca los disputados; usa el mismo advisory lock que la aplicación instantánea.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotente: si ya existe el job con este nombre, lo quita antes de recrearlo.
SELECT cron.unschedule('v2_aplicar_pendientes')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'v2_aplicar_pendientes');

SELECT cron.schedule(
  'v2_aplicar_pendientes',
  '*/5 * * * *',
  $$SELECT public.aplicar_pendientes();$$
);
