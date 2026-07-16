-- =====================================================================
-- CUTOVER 00b — BASE FALTANTE EN PROD (prerrequisito de las migraciones)
-- =====================================================================
-- El respaldo del 2026-07-16 mostró que PROD NO tiene objetos que las
-- migraciones 010–024 y sus funciones ASUMEN preexistentes. Sin esto, el
-- cutover muere en la migración 011 (ALTER TABLE v2_config…).
--
-- Todo es IDEMPOTENTE. Ejecutar DESPUÉS de la PRE-FLIGHT (FASE 0 de
-- cutover_03) y de cutover_00_prereqs.sql, y ANTES de cutover_01.
--
-- Cierra 3 faltantes detectados en prod:
--   (a) tabla v2_config + fila id=1 (columnas base pre-011; las demás las
--       agregan las migraciones vía ADD COLUMN IF NOT EXISTS).
--   (b) challenges.disputado / resultado_ingresado_at / disputa_motivo.
--   (c) función stamp_resultado_ingresado() + trigger trg_stamp_resultado.
-- =====================================================================

-- ── (a) v2_config: tabla base + fila id=1 ────────────────────────────
-- Solo las columnas base (pre-011). max_puestos_desafio, last_cron_*,
-- last_foto_jueves_date, nombre_club y formato_partido las añaden las
-- migraciones 011/013/014/020/021. Los campos de fecha quedan en NULL:
-- en prod los relojes parten limpios (cutover_02 fija la config definitiva).
CREATE TABLE IF NOT EXISTS public.v2_config (
  id                          integer PRIMARY KEY DEFAULT 1,
  ventana_validacion_minutos  integer DEFAULT 120,
  dias_expiracion_desafio     integer DEFAULT 7,
  horas_wo_cancelacion        integer DEFAULT 24,
  ultima_corrida_inactividad  date
);

INSERT INTO public.v2_config
  (id, ventana_validacion_minutos, dias_expiracion_desafio, horas_wo_cancelacion, ultima_corrida_inactividad)
VALUES
  (1, 90, 7, 24, NULL)      -- ventana=90 (igual que prueba); cutover_02 la deja en 1440
ON CONFLICT (id) DO NOTHING;

-- ── (b) challenges: columnas base pre-010 ausentes en prod ───────────
ALTER TABLE public.challenges ADD COLUMN IF NOT EXISTS disputado              boolean DEFAULT false;
ALTER TABLE public.challenges ADD COLUMN IF NOT EXISTS resultado_ingresado_at timestamptz;
ALTER TABLE public.challenges ADD COLUMN IF NOT EXISTS disputa_motivo         text;

-- ── (c) trigger que estampa resultado_ingresado_at ───────────────────
-- Reinicia el reloj de la ventana cuando aparece/cambia un resultado, y lo
-- limpia (junto con la disputa) cuando se borra el ganador.
CREATE OR REPLACE FUNCTION public.stamp_resultado_ingresado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Aparece un ganador (o cambia): reinicia el reloj de la ventana
  IF NEW.ganador IS NOT NULL
     AND (OLD.ganador IS DISTINCT FROM NEW.ganador
          OR OLD.score_a IS DISTINCT FROM NEW.score_a
          OR OLD.score_b IS DISTINCT FROM NEW.score_b)
     AND NEW.ranking_applied = false
  THEN
    NEW.resultado_ingresado_at := now();
  END IF;
  -- Se borra el resultado: limpia el reloj y la disputa
  IF NEW.ganador IS NULL AND OLD.ganador IS NOT NULL THEN
    NEW.resultado_ingresado_at := NULL;
    NEW.disputado := false;
    NEW.disputa_motivo := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_resultado ON public.challenges;
CREATE TRIGGER trg_stamp_resultado
  BEFORE UPDATE ON public.challenges
  FOR EACH ROW EXECUTE FUNCTION public.stamp_resultado_ingresado();
