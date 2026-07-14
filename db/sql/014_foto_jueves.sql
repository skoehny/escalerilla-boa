-- V2 — Migración 014: foto_jueves()
-- =====================================================================
-- La "foto del jueves" (regla 6): ya NO hay publicación manual. Cada jueves,
-- en una transacción y con el mismo advisory lock de aplicar_resultado:
--   1. SNAPSHOT a ranking_history (semana = weekly_config.semana+1) con los
--      activos con posición; ON CONFLICT (semana) DO UPDATE (idempotente).
--   2. RESUMEN en ranking_history.movimientos = { movements[], notas[] } con el
--      formato que ya lee la UI del historial (Resultados.jsx).
--   3. FLECHAS: posicion_anterior := posicion para todos los activos (la nueva
--      foto pasa a ser la referencia de las flechas de la próxima semana).
--   4. SEMANA: weekly_config.semana += 1, fecha_inicio = hoy, fecha_cierre y
--      fecha_ranking = hoy + 7, publicado_manual = false.
--   5. Guard de idempotencia semanal: v2_config.last_foto_jueves_date; si ya
--      corrió hoy, salta (permite invocación manual segura).
--
-- SCHEDULING: pg_cron los jueves 16:00 UTC (= 12:00 Chile en invierno / 13:00
-- en verano — deriva aceptable).
--   Pausar:   SELECT cron.unschedule('v2_foto_jueves');
--   Reanudar: SELECT cron.schedule('v2_foto_jueves','0 16 * * 4', $$SELECT public.foto_jueves();$$);
--   A mano:   UPDATE v2_config SET last_foto_jueves_date=NULL WHERE id=1; SELECT public.foto_jueves();
-- =====================================================================

ALTER TABLE v2_config ADD COLUMN IF NOT EXISTS last_foto_jueves_date date;

CREATE OR REPLACE FUNCTION public.foto_jueves()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today       date;
  v_last        date;
  v_sem         integer;
  v_nueva_sem   integer;
  v_data        jsonb;
  v_moves       jsonb;
  v_notas       jsonb;
  v_mov         jsonb;
  v_partidos    text[];
  v_les         text[];
  v_inact       text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := current_date;
  SELECT last_foto_jueves_date INTO v_last FROM v2_config WHERE id = 1;
  IF v_last = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

  SELECT semana INTO v_sem FROM weekly_config WHERE id = 1;
  v_nueva_sem := COALESCE(v_sem, 0) + 1;

  -- 1) SNAPSHOT de los activos con posición
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'nombre', nombre, 'apellido', apellido,
           'posicion', posicion, 'victorias', victorias, 'derrotas', derrotas
         ) ORDER BY posicion), '[]'::jsonb)
    INTO v_data
    FROM players WHERE activo AND posicion IS NOT NULL;

  -- 2a) movements: posicion actual vs posicion_anterior (foto de la semana pasada)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'nombre', nombre || ' ' || apellido,
           'desde',  posicion_anterior,
           'hasta',  posicion,
           'delta',  posicion_anterior - posicion,
           'motivo', 'movimiento de la semana'
         ) ORDER BY posicion), '[]'::jsonb)
    INTO v_moves
    FROM players
   WHERE activo AND posicion IS NOT NULL
     AND posicion_anterior IS NOT NULL
     AND posicion_anterior <> posicion;

  -- 2b) notas: partidos de los últimos 7 días
  SELECT array_agg(
           ch.nombre || ' ' || ch.apellido || ' ' || c.score_a || '-' || c.score_b
           || CASE WHEN c.is_wo THEN ' WO' ELSE '' END || ' '
           || cd.nombre || ' ' || cd.apellido
           ORDER BY c.applied_at)
    INTO v_partidos
    FROM challenges c
    JOIN players ch ON ch.id = c.challenger_id
    JOIN players cd ON cd.id = c.challenged_id
   WHERE c.status = 'completed'
     AND c.applied_at IS NOT NULL
     AND c.applied_at >= now() - interval '7 days';

  -- notas: lesionados
  SELECT array_agg(nombre || ' ' || apellido || ' está lesionado' ORDER BY posicion)
    INTO v_les
    FROM players WHERE activo AND lesionado;

  -- notas: inactivos (>= 7 días sin jugar)
  SELECT array_agg(
           nombre || ' ' || apellido || ' lleva '
           || semanas_inactivo || ' semanas (' || dias_inactivo || ' días) sin jugar'
           ORDER BY dias_inactivo DESC)
    INTO v_inact
    FROM players WHERE activo AND dias_inactivo >= 7;

  v_notas := to_jsonb(
    COALESCE(v_partidos, '{}'::text[])
    || COALESCE(v_les,   '{}'::text[])
    || COALESCE(v_inact, '{}'::text[])
  );

  v_mov := jsonb_build_object('movements', v_moves, 'notas', v_notas, 'penaltyLog', '[]'::jsonb);

  -- Insertar / actualizar la foto de la semana
  INSERT INTO ranking_history (semana, fecha, data, movimientos, publicado_por, hora_publicacion)
  VALUES (v_nueva_sem, v_today, v_data, v_mov, 'auto', now())
  ON CONFLICT (semana) DO UPDATE
    SET fecha            = EXCLUDED.fecha,
        data             = EXCLUDED.data,
        movimientos      = EXCLUDED.movimientos,
        publicado_por    = EXCLUDED.publicado_por,
        hora_publicacion = EXCLUDED.hora_publicacion;

  -- 3) FLECHAS: la nueva foto pasa a ser la referencia
  UPDATE players SET posicion_anterior = posicion
   WHERE activo AND posicion IS NOT NULL;

  -- 4) Avanzar semana
  UPDATE weekly_config
     SET semana           = v_nueva_sem,
         fecha_inicio     = v_today,
         fecha_cierre     = v_today + 7,
         fecha_ranking    = v_today + 7,
         publicado_manual = false
   WHERE id = 1;

  -- 5) Sello de idempotencia
  UPDATE v2_config SET last_foto_jueves_date = v_today WHERE id = 1;

  RETURN jsonb_build_object(
    'ok', true,
    'fecha', v_today,
    'semana', v_nueva_sem,
    'jugadores', jsonb_array_length(v_data),
    'movimientos', jsonb_array_length(v_moves),
    'notas', jsonb_array_length(v_notas)
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'foto_jueves falló: %', SQLERRM;
END;
$function$
;

-- ── Programar los jueves 16:00 UTC (idempotente) ─────────────────────
SELECT cron.unschedule('v2_foto_jueves')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'v2_foto_jueves');

SELECT cron.schedule('v2_foto_jueves', '0 16 * * 4', $$SELECT public.foto_jueves();$$);
