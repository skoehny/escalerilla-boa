-- V2 — Migración 030: el #1 del ranking no acumula reloj de inactividad
-- =====================================================================
-- ⚠ SUPERADA POR LA MIG 031 (db/sql/031_lider_visible_no_penalizado.sql).
--   Se deja como historia: la 030 estuvo vigente en prod y su definición es el
--   punto de partida de la 031. El diseño cambió: el reloj del #1 vuelve a correr
--   (es información visible) y lo que se le perdona son las CONSECUENCIAS
--   (penalización de puestos e insignia automática de lesionado). No la apliques.
-- =====================================================================
-- INCIDENTE QUE LA ORIGINA
--   El jugador en posición #1 fue penalizado por inactividad por cron_diario y
--   bajó puestos. Es un error de diseño: el #1 NO puede desafiar a nadie (solo
--   puede ser desafiado, mig 016/028: el desafiado debe tener menor posición).
--   Si nadie lo desafía, su inactividad no depende de él y no puede castigarlo.
--
-- REGLA NUEVA (permanente y automática)
--   Mientras un jugador ocupe la posición 1:
--     • su reloj NO acumula (queda excluido del incremento diario),
--     • no cruza umbrales => no se le aplican penalizaciones ni la insignia
--       automática de lesionado por inactividad,
--     • dias_inactivo y semanas_inactivo se mantienen en 0, así que la UI no le
--       muestra badge de inactividad (Ranking.jsx / JugadorPerfil.jsx ocultan el
--       badge con dias_inactivo < 7) ni aparece en las notas de foto_jueves
--       (lista a los de dias_inactivo >= 7).
--   La exención sigue a la POSICIÓN, no al jugador: quien llegue al #1 la recibe
--   sin intervención manual, y quien deje el #1 vuelve al régimen normal.
--
-- POR QUÉ "dias_inactivo = 0" Y NO "congelar en el valor que traía"
--   La decisión de diseño es que el #1 parta con RELOJ LIMPIO cuando baje, para
--   que no le caiga de golpe la inactividad acumulada. En este esquema la fuente
--   única de inactividad es el contador incremental players.dias_inactivo (no una
--   diferencia de fechas), así que "avanzar la fecha de referencia cada día"
--   equivale exactamente a mantener el contador en 0 mientras es #1. Al llegar al
--   #1 el contador ya viene en 0 de todas formas (se llega ganando un desafío y
--   aplicar_resultado lo resetea); el UPDATE cubre además el caso de un #1
--   instalado por admin_ajustar_posicion o con reloj sucio de antes.
--
-- LO QUE NO TOCA
--   • dias_ajuste_saneo (mig 027): es informativo para el popup y no participa de
--     ningún cálculo. Los días que el #1 pasa exento aparecen en el popup como
--     "días pausados" — que es justo lo que son.
--   • La lesión MANUAL: solo se limpia la insignia puesta por el cron, que se
--     reconoce por lesion_nota = 'Inactividad (4 semanas)' (el cron solo escribe
--     esa nota cuando lesion_nota venía vacía, así que nunca pisa una nota real).
--   • Las pausas por desafío activo, el congelamiento global (mig 025/026), el
--     congelamiento individual (mig 023), la expiración de desafíos, el freno de
--     las penalizaciones, aplicar_resultado, crear_desafio ni foto_jueves.
--
-- ALCANCE: CREATE OR REPLACE de cron_diario() (base: mig 026) + una normalización
--   one-shot del #1 actual al aplicar, para no esperar a la corrida de mañana.
--   La reparación del incidente concreto (devolver al jugador penalizado a la #1)
--   va aparte, en db/cutover/incidente_lider_inactividad.sql.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last_date date; v_dias_exp integer;
  v_congel_motivo text; n_aplaz integer := 0;
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0; n_lider integer := 0;
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

  -- ── RAMA CONGELADA (mig 026) ────────────────────────────────────────
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

  -- ── EXENCIÓN DEL #1 (mig 030) ───────────────────────────────────────
  -- Antes de cualquier cálculo: el líder deja el reloj en 0. Normalmente ya está
  -- en 0 (llegó al #1 ganando) y este UPDATE no toca nada; cubre al #1 instalado
  -- a mano o con reloj sucio. Solo limpia la lesión puesta por el propio cron.
  WITH lider AS (
    UPDATE players
       SET dias_inactivo    = 0,
           semanas_inactivo = 0,
           lesionado    = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN false ELSE lesionado END,
           lesion_nota  = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN ''    ELSE lesion_nota END,
           lesion_fecha = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN NULL  ELSE lesion_fecha END
     WHERE activo AND posicion = 1
       AND ( dias_inactivo <> 0
             OR semanas_inactivo <> 0
             OR lesion_nota = 'Inactividad (4 semanas)' )
    RETURNING id, posicion
  )
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  SELECT id, 'inactividad', 'exención del #1: el líder no acumula reloj', posicion, posicion
    FROM lider;
  GET DIAGNOSTICS n_lider = ROW_COUNT;

  -- INCREMENTO: +1 a activos sin pausa, sin resultado hoy, no debutantes,
  -- no congelados y que NO sean el #1 (su inactividad no depende de él).
  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND p.posicion IS DISTINCT FROM 1
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

  -- (No hace falta re-normalizar el #1 después del reacomodo: el único movimiento
  --  que produce esta rama es bajar penalizados, y el #1 ya no puede ser
  --  penalizado, así que el ocupante de la posición 1 no cambia dentro del cron.)

  IF movio THEN UPDATE v2_config SET last_cron_movement_at = now() WHERE id = 1; END IF;
  UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'fecha', v_today, 'expirados', n_exp,
    'penalizados', n_pen, 'lesionados_nuevos', n_les, 'lider_exento', n_lider,
    'movio', movio, 'movimientos', moved);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cron_diario falló: %', SQLERRM;
END;
$function$;

-- ── Normalización one-shot del #1 actual ──────────────────────────────
-- Misma sentencia que corre el cron, para que la exención quede visible al
-- aplicar la migración y no al día siguiente. Idempotente: si el #1 ya está
-- limpio no toca nada ni escribe log.
WITH lider AS (
  UPDATE players
     SET dias_inactivo    = 0,
         semanas_inactivo = 0,
         lesionado    = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN false ELSE lesionado END,
         lesion_nota  = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN ''    ELSE lesion_nota END,
         lesion_fecha = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN NULL  ELSE lesion_fecha END
   WHERE activo AND posicion = 1
     AND ( dias_inactivo <> 0 OR semanas_inactivo <> 0 OR lesion_nota = 'Inactividad (4 semanas)' )
  RETURNING id, posicion
)
INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
SELECT id, 'inactividad', 'exención del #1: el líder no acumula reloj', posicion, posicion
  FROM lider;
