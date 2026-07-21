-- V2 — Migración 026: aplazamiento INCREMENTAL de deadlines durante el freeze
-- =====================================================================
-- CAMBIO DE DISEÑO respecto de la mig 025:
--   ANTES: `descongelar_reloj_global` extendía de una sola vez las fechas
--   límite de TODOS los desafíos vigentes por los días totales del freeze.
--   BUG: un desafío creado a MITAD del freeze recibía la extensión TOTAL,
--   aunque solo vivió congelado una parte.
--
--   AHORA: `cron_diario`, cuando el reloj está congelado, hace EXACTAMENTE una
--   cosa por día: suma +1 al deadline de cada desafío pendiente/aceptado (con
--   log). Así un desafío creado a mitad del freeze solo recibe +1 por cada día
--   que ÉL vivió congelado. `descongelar` ya NO extiende nada (se aplicó día a
--   día). Beneficio: el deadline mostrado siempre es real; no hay que estimar.
--
-- GUARD (idempotencia diaria, documentado): la rama congelada TAMBIÉN avanza
-- v2_config.last_cron_daily_date. Esto impide correr 2 veces el mismo día
-- (cron programado + botón manual) → el deadline sube +1 una sola vez por día.
-- Efecto colateral ACEPTADO Y DESEADO: si se descongela el MISMO día en que ya
-- corrió la rama congelada, el cron normal de ese día queda como "ya corrido"
-- y NO suma inactividad — correcto, porque ese día estuvo parcialmente
-- congelado. Al día siguiente el cron normal opera con normalidad.
-- =====================================================================

-- ── cron_diario: rama congelada = aplazar deadlines +1/día ────────────
CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last_date date; v_dias_exp integer;
  v_congel_motivo text; n_aplaz integer := 0;
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0;
  arr_id uuid[]; n integer; k integer; idx integer; step integer; rec RECORD;
  movio boolean := false; moved jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := (now() AT TIME ZONE 'UTC')::date;
  SELECT last_cron_daily_date, COALESCE(dias_expiracion_desafio, 7)
    INTO v_last_date, v_dias_exp FROM v2_config WHERE id = 1;

  -- Guard de idempotencia diaria (aplica a AMBAS ramas: normal y congelada).
  IF v_last_date = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

  -- ── RAMA CONGELADA ──────────────────────────────────────────────────
  -- Única acción: aplazar +1 día el deadline de los desafíos vigentes.
  -- NO suma dias_inactivo, NO expira, NO penaliza, NO procesa WO.
  SELECT motivo INTO v_congel_motivo
    FROM reloj_freeze_log WHERE descongelado_en IS NULL LIMIT 1;
  IF v_congel_motivo IS NOT NULL THEN
    UPDATE challenges
       SET deadline = COALESCE(deadline, created_at::date + v_dias_exp) + 1
     WHERE status IN ('pending', 'accepted');
    GET DIAGNOSTICS n_aplaz = ROW_COUNT;

    INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta, challenge_id)
    SELECT challenger_id, 'admin', 'aplazamiento diario por congelamiento', NULL, NULL, id
      FROM challenges WHERE status IN ('pending', 'accepted');

    -- Avanza el guard: 1 aplazamiento por día como máximo.
    UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

    RETURN jsonb_build_object('ok', true, 'skipped', 'reloj_congelado',
      'motivo', v_congel_motivo, 'aplazados', n_aplaz, 'fecha', v_today);
  END IF;

  -- ── RAMA NORMAL ─────────────────────────────────────────────────────
  UPDATE challenges SET status = 'expired'
   WHERE status IN ('pending','accepted')
     AND ( (deadline IS NOT NULL AND deadline < v_today)
        OR (deadline IS NULL AND created_at + make_interval(days => v_dias_exp) < now()) );
  GET DIAGNOSTICS n_exp = ROW_COUNT;

  DROP TABLE IF EXISTS _paused;
  CREATE TEMP TABLE _paused ON COMMIT DROP AS
    SELECT challenger_id AS pid FROM challenges WHERE status IN ('pending','accepted') AND challenger_id IS NOT NULL
    UNION
    SELECT challenged_id       FROM challenges WHERE status IN ('pending','accepted') AND challenged_id IS NOT NULL;

  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND NOT COALESCE(p.inactividad_congelada, false)
       AND p.id NOT IN (SELECT pid FROM _paused)
       AND (p.ultima_fecha_jugada IS NULL OR p.ultima_fecha_jugada::date < v_today)
       AND NOT (COALESCE(p.victorias,0) = 0 AND COALESCE(p.derrotas,0) = 0);

  UPDATE players SET dias_inactivo = dias_inactivo + 1 WHERE id IN (SELECT id FROM _incr);

  UPDATE players SET semanas_inactivo = floor(dias_inactivo / 7.0)::int
   WHERE activo AND semanas_inactivo IS DISTINCT FROM floor(dias_inactivo / 7.0)::int;

  UPDATE players
     SET lesionado = true, lesion_fecha = now(),
         lesion_nota = CASE WHEN COALESCE(lesion_nota,'') = '' THEN 'Inactividad (4 semanas)' ELSE lesion_nota END
   WHERE id IN (SELECT id FROM _incr) AND dias_inactivo = 28;
  GET DIAGNOSTICS n_les = ROW_COUNT;

  DROP TABLE IF EXISTS _pen;
  CREATE TEMP TABLE _pen ON COMMIT DROP AS
    SELECT p.id, p.posicion AS pos_ini,
           CASE WHEN p.dias_inactivo = 14 THEN 2 ELSE 1 END AS steps
      FROM players p
     WHERE p.id IN (SELECT id FROM _incr)
       AND ( p.dias_inactivo = 14 OR (p.dias_inactivo > 14 AND (p.dias_inactivo - 14) % 7 = 0) );
  SELECT count(*) INTO n_pen FROM _pen;

  DROP TABLE IF EXISTS _barrier;
  CREATE TEMP TABLE _barrier ON COMMIT DROP AS
    SELECT id FROM players
     WHERE activo AND posicion IS NOT NULL
       AND ( dias_inactivo >= 14 OR (COALESCE(victorias,0) = 0 AND COALESCE(derrotas,0) = 0) );

  DROP TABLE IF EXISTS _before;
  CREATE TEMP TABLE _before ON COMMIT DROP AS
    SELECT id, posicion FROM players WHERE activo AND posicion IS NOT NULL;

  SELECT array_agg(id ORDER BY posicion) INTO arr_id FROM players WHERE activo AND posicion IS NOT NULL;
  n := COALESCE(array_length(arr_id, 1), 0);

  IF n > 0 THEN
    FOR rec IN SELECT pen.id, pen.steps FROM _pen pen JOIN players p ON p.id = pen.id ORDER BY p.posicion DESC LOOP
      idx := array_position(arr_id, rec.id);
      IF idx IS NULL THEN CONTINUE; END IF;
      FOR step IN 1..rec.steps LOOP
        IF idx + 1 > n THEN EXIT; END IF;
        IF EXISTS (SELECT 1 FROM _barrier b WHERE b.id = arr_id[idx + 1]) THEN EXIT; END IF;
        arr_id[idx] := arr_id[idx + 1]; arr_id[idx + 1] := rec.id; idx := idx + 1; movio := true;
      END LOOP;
    END LOOP;
    IF movio THEN
      UPDATE players SET posicion = -posicion WHERE activo AND posicion IS NOT NULL;
      FOR k IN 1..n LOOP UPDATE players SET posicion = k WHERE id = arr_id[k]; END LOOP;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', b.id, 'desde', b.posicion, 'hasta', p.posicion, 'delta', b.posicion - p.posicion) ORDER BY p.posicion), '[]'::jsonb)
    INTO moved FROM _before b JOIN players p ON p.id = b.id WHERE b.posicion IS DISTINCT FROM p.posicion;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  SELECT b.id, 'inactividad',
         CASE WHEN pen.id IS NOT NULL THEN 'penalización por inactividad' ELSE 'reacomodo por inactividad' END,
         b.posicion, p.posicion
    FROM _before b JOIN players p ON p.id = b.id LEFT JOIN _pen pen ON pen.id = b.id
   WHERE b.posicion IS DISTINCT FROM p.posicion;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  SELECT p.id, 'inactividad', 'lesionado por inactividad (28 días)', p.posicion, p.posicion
    FROM players p WHERE p.id IN (SELECT id FROM _incr) AND p.dias_inactivo = 28;

  IF movio THEN UPDATE v2_config SET last_cron_movement_at = now() WHERE id = 1; END IF;
  UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'fecha', v_today, 'expirados', n_exp,
    'penalizados', n_pen, 'lesionados_nuevos', n_les, 'movio', movio, 'movimientos', moved);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cron_diario falló: %', SQLERRM;
END;
$function$;

-- ── descongelar_reloj_global: YA NO extiende deadlines ────────────────
-- (la extensión ocurrió día a día en cron_diario). Solo cierra el freeze,
-- computa dias_congelados (informativo) y lo registra.
CREATE OR REPLACE FUNCTION public.descongelar_reloj_global(p_admin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id    uuid;
  v_desde timestamptz;
  v_dias  integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT id, congelado_desde INTO v_id, v_desde
    FROM reloj_freeze_log
   WHERE descongelado_en IS NULL
   FOR UPDATE;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'El reloj de inactividad no está congelado';
  END IF;

  -- Informativo: días calendario completos que duró el freeze (mínimo 0).
  v_dias := GREATEST(0, (date_trunc('day', now())::date - date_trunc('day', v_desde)::date));

  UPDATE reloj_freeze_log
     SET descongelado_en    = now(),
         descongelado_por    = NULLIF(btrim(COALESCE(p_admin, '')), ''),
         dias_congelados     = v_dias,
         desafios_extendidos = NULL   -- ya no aplica: la extensión fue diaria
   WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'dias_congelados', v_dias);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'descongelar_reloj_global falló: %', SQLERRM;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.descongelar_reloj_global(text) TO anon, authenticated;
