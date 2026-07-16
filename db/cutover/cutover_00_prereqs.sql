-- =====================================================================
-- CUTOVER 00 — PRERREQUISITOS (funciones NO versionadas en db/sql/)
-- =====================================================================
-- ⚠ IMPORTANTE: estas dos funciones EXISTEN en la base de PRUEBA pero NO están
-- en ningún archivo de migración (se crearon a mano durante el desarrollo).
-- El esquema v2 las necesita:
--   • recalcular_stats(): la LLAMA aplicar_resultado (mig 010/016). Sin ella,
--     TODA aplicación de resultado falla.
--   • aplicar_pendientes(): la ejecuta el cron v2_aplicar_pendientes (mig 012,
--     agendado */5). Sin ella, ese cron falla cada 5 minutos.
--
-- Ambas son idempotentes (CREATE OR REPLACE). Si prod YA las tiene (venían de
-- v1 / dev previo), esto no hace daño: reescribe con la misma definición.
--
-- ORDEN: ejecutar ANTES de cutover_01. Nota: recalcular_stats es una función
-- SQL y Postgres valida su cuerpo al crearla — si FALLA aquí por "column ...
-- does not exist", significa que prod NO tiene el esquema base (pre-010) y el
-- cutover está incompleto: DETENER y revisar la PRE-FLIGHT del README.
-- =====================================================================

-- ── recalcular_stats: recomputa victorias/derrotas desde challenges ──
CREATE OR REPLACE FUNCTION public.recalcular_stats(p_a uuid, p_b uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update players p
  set
    victorias = (
      select count(*) from challenges c
      where c.status = 'completed'
        and ( (c.challenger_id = p.id and c.ganador = 'challenger')
           or (c.challenged_id = p.id and c.ganador = 'challenged') )
    ),
    derrotas = (
      select count(*) from challenges c
      where c.status = 'completed'
        and ( (c.challenger_id = p.id and c.ganador = 'challenged')
           or (c.challenged_id = p.id and c.ganador = 'challenger') )
    )
  where p.id = p_a
     or (p_b is not null and p.id = p_b);
$function$
;

-- ── aplicar_pendientes: red de seguridad del cron */5 ──
CREATE OR REPLACE FUNCTION public.aplicar_pendientes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ventana_min integer;
  ch RECORD;
  res jsonb;
  aplicados jsonb := '[]'::jsonb;
  n integer := 0;
BEGIN
  SELECT ventana_validacion_minutos INTO ventana_min FROM v2_config WHERE id = 1;

  FOR ch IN
    SELECT id FROM challenges
    WHERE status = 'completed'
      AND ganador IS NOT NULL
      AND ranking_applied = false
      AND disputado = false
      AND (
        resultado_validado = true
        OR (resultado_ingresado_at IS NOT NULL
            AND resultado_ingresado_at < now() - make_interval(mins => ventana_min))
      )
    ORDER BY resultado_ingresado_at NULLS FIRST
  LOOP
    res := aplicar_resultado(ch.id);
    aplicados := aplicados || jsonb_build_object('challenge_id', ch.id, 'resultado', res);
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'aplicados', n, 'detalle', aplicados);
END;
$function$
;
