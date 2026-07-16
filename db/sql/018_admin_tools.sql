-- V2 — Migración 018 (ETAPA H): herramientas admin + fix de expiración
-- =====================================================================
-- 1) cron_diario: expira desafíos por la COLUMNA deadline (lo que vio el jugador
--    al crear manda; cambiar la config solo afecta desafíos nuevos). Fallback a
--    created_at + dias_expiracion para desafíos legacy sin deadline. (Resto igual.)
-- 2) admin_ajustar_posicion(p_player, p_nueva_pos, p_motivo): mueve un jugador a
--    una posición, desplaza a los demás (+1/-1), valida rango 1..n, loguea en
--    ranking_log causa 'admin' con el motivo (desde/hasta reales).
-- =====================================================================

-- ── cron_diario (solo cambia el bloque de expiración) ────────────────
CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today     date;
  v_last_date date;
  v_dias_exp  integer;
  n_exp       integer := 0;
  n_pen       integer := 0;
  n_les       integer := 0;
  arr_id      uuid[];
  n           integer;
  k           integer;
  idx         integer;
  step        integer;
  rec         RECORD;
  movio       boolean := false;
  moved       jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := (now() AT TIME ZONE 'UTC')::date;
  SELECT last_cron_daily_date, COALESCE(dias_expiracion_desafio, 7)
    INTO v_last_date, v_dias_exp
    FROM v2_config WHERE id = 1;

  IF v_last_date = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

  -- 1) EXPIRAR DESAFÍOS por la columna deadline (fallback legacy por created_at)
  UPDATE challenges
     SET status = 'expired'
   WHERE status IN ('pending','accepted')
     AND ( (deadline IS NOT NULL AND deadline < v_today)
        OR (deadline IS NULL AND created_at + make_interval(days => v_dias_exp) < now()) );
  GET DIAGNOSTICS n_exp = ROW_COUNT;

  -- 2) PAUSADOS: jugadores con desafío pending/accepted (tras expirar)
  DROP TABLE IF EXISTS _paused;
  CREATE TEMP TABLE _paused ON COMMIT DROP AS
    SELECT challenger_id AS pid FROM challenges WHERE status IN ('pending','accepted') AND challenger_id IS NOT NULL
    UNION
    SELECT challenged_id       FROM challenges WHERE status IN ('pending','accepted') AND challenged_id IS NOT NULL;

  -- 3) INCREMENTO: +1 a activos sin pausa, sin resultado hoy y que NO sean
  --    debutantes (v=0 y d=0): el debutante no tiene reloj hasta su 1er resultado.
  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND p.id NOT IN (SELECT pid FROM _paused)
       AND (p.ultima_fecha_jugada IS NULL OR p.ultima_fecha_jugada::date < v_today)
       AND NOT (COALESCE(p.victorias,0) = 0 AND COALESCE(p.derrotas,0) = 0);

  UPDATE players SET dias_inactivo = dias_inactivo + 1
   WHERE id IN (SELECT id FROM _incr);

  -- Sincronizar semanas_inactivo (badge UI) para todos los activos
  UPDATE players
     SET semanas_inactivo = floor(dias_inactivo / 7.0)::int
   WHERE activo AND semanas_inactivo IS DISTINCT FROM floor(dias_inactivo / 7.0)::int;

  -- Lesionado a los 28 días exactos (solo quien cruzó hoy)
  UPDATE players
     SET lesionado = true, lesion_fecha = now(),
         lesion_nota = CASE WHEN COALESCE(lesion_nota,'') = '' THEN 'Inactividad (4 semanas)' ELSE lesion_nota END
   WHERE id IN (SELECT id FROM _incr) AND dias_inactivo = 28;
  GET DIAGNOSTICS n_les = ROW_COUNT;

  -- 4) PENALIZADOS: cruzaron HOY un umbral exacto (14,21,28,35,...)
  DROP TABLE IF EXISTS _pen;
  CREATE TEMP TABLE _pen ON COMMIT DROP AS
    SELECT p.id,
           p.posicion AS pos_ini,
           CASE WHEN p.dias_inactivo = 14 THEN 2 ELSE 1 END AS steps
      FROM players p
     WHERE p.id IN (SELECT id FROM _incr)
       AND ( p.dias_inactivo = 14
             OR (p.dias_inactivo > 14 AND (p.dias_inactivo - 14) % 7 = 0) );
  SELECT count(*) INTO n_pen FROM _pen;

  -- Barrera del freno: inactivos >=14 o debutantes (v=0 y d=0)
  DROP TABLE IF EXISTS _barrier;
  CREATE TEMP TABLE _barrier ON COMMIT DROP AS
    SELECT id FROM players
     WHERE activo AND posicion IS NOT NULL
       AND ( dias_inactivo >= 14 OR (COALESCE(victorias,0) = 0 AND COALESCE(derrotas,0) = 0) );

  -- Foto previa para el resumen de movimientos
  DROP TABLE IF EXISTS _before;
  CREATE TEMP TABLE _before ON COMMIT DROP AS
    SELECT id, posicion FROM players WHERE activo AND posicion IS NOT NULL;

  -- Reordenar: bajar cada penalizado N pasos, de abajo hacia arriba, con freno
  SELECT array_agg(id ORDER BY posicion) INTO arr_id
    FROM players WHERE activo AND posicion IS NOT NULL;
  n := COALESCE(array_length(arr_id, 1), 0);

  IF n > 0 THEN
    FOR rec IN
      SELECT pen.id, pen.steps
        FROM _pen pen JOIN players p ON p.id = pen.id
       ORDER BY p.posicion DESC       -- posición mayor (abajo) primero
    LOOP
      idx := array_position(arr_id, rec.id);
      IF idx IS NULL THEN CONTINUE; END IF;
      FOR step IN 1..rec.steps LOOP
        IF idx + 1 > n THEN EXIT; END IF;
        IF EXISTS (SELECT 1 FROM _barrier b WHERE b.id = arr_id[idx + 1]) THEN EXIT; END IF;
        arr_id[idx]     := arr_id[idx + 1];
        arr_id[idx + 1] := rec.id;
        idx := idx + 1;
        movio := true;
      END LOOP;
    END LOOP;

    IF movio THEN
      UPDATE players SET posicion = -posicion WHERE activo AND posicion IS NOT NULL;
      FOR k IN 1..n LOOP
        UPDATE players SET posicion = k WHERE id = arr_id[k];
      END LOOP;
    END IF;
  END IF;

  -- Resumen de movimientos
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', b.id, 'desde', b.posicion, 'hasta', p.posicion,
           'delta', b.posicion - p.posicion) ORDER BY p.posicion), '[]'::jsonb)
    INTO moved
    FROM _before b JOIN players p ON p.id = b.id
   WHERE b.posicion IS DISTINCT FROM p.posicion;

  -- Auditoría: cada jugador que cambió de posición (penalizado o reacomodado)
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  SELECT b.id, 'inactividad',
         CASE WHEN pen.id IS NOT NULL THEN 'penalización por inactividad'
              ELSE 'reacomodo por inactividad' END,
         b.posicion, p.posicion
    FROM _before b
    JOIN players p   ON p.id = b.id
    LEFT JOIN _pen pen ON pen.id = b.id
   WHERE b.posicion IS DISTINCT FROM p.posicion;

  -- Auditoría: lesionados por inactividad (28 días), aunque no muevan posición
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  SELECT p.id, 'inactividad', 'lesionado por inactividad (28 días)', p.posicion, p.posicion
    FROM players p
   WHERE p.id IN (SELECT id FROM _incr) AND p.dias_inactivo = 28;

  -- 5) Sellos
  IF movio THEN
    UPDATE v2_config SET last_cron_movement_at = now() WHERE id = 1;
  END IF;
  UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

  RETURN jsonb_build_object(
    'ok', true,
    'fecha', v_today,
    'expirados', n_exp,
    'penalizados', n_pen,
    'lesionados_nuevos', n_les,
    'movio', movio,
    'movimientos', moved
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cron_diario falló: %', SQLERRM;
END;
$function$
;

-- ── admin_ajustar_posicion ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_ajustar_posicion(
  p_player    uuid,
  p_nueva_pos integer,
  p_motivo    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old integer;
  v_n   integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'Debes indicar un motivo para el ajuste';
  END IF;

  SELECT count(*) INTO v_n FROM players WHERE activo AND posicion IS NOT NULL;
  IF p_nueva_pos IS NULL OR p_nueva_pos < 1 OR p_nueva_pos > v_n THEN
    RAISE EXCEPTION 'Posición fuera de rango (1..%)', v_n;
  END IF;

  SELECT posicion INTO v_old FROM players WHERE id = p_player AND activo;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'El jugador no está activo en el ranking';
  END IF;

  IF v_old = p_nueva_pos THEN
    RETURN jsonb_build_object('ok', true, 'sin_cambio', true, 'posicion', v_old);
  END IF;

  IF p_nueva_pos < v_old THEN
    -- Sube: los de [nueva_pos, old-1] bajan 1
    UPDATE players SET posicion = posicion + 1
     WHERE activo AND posicion >= p_nueva_pos AND posicion < v_old;
  ELSE
    -- Baja: los de [old+1, nueva_pos] suben 1
    UPDATE players SET posicion = posicion - 1
     WHERE activo AND posicion > v_old AND posicion <= p_nueva_pos;
  END IF;

  UPDATE players SET posicion = p_nueva_pos WHERE id = p_player;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo, v_old, p_nueva_pos);

  RETURN jsonb_build_object('ok', true, 'desde', v_old, 'hasta', p_nueva_pos);

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'admin_ajustar_posicion falló: %', SQLERRM;
END;
$function$
;
