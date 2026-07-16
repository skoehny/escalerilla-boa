-- V2 — Migración 016: creación de desafíos con reglas + ranking_log (auditoría)
-- =====================================================================
-- - ranking_log: bitácora de auditoría de movimientos (resultado/inactividad/
--   reactivacion/admin). La instrumentan aplicar_resultado, cron_diario,
--   crear_desafio y (etapa H) admin_ajustar_posicion.
-- - v2_config: max_puestos_desafio (ya existía desde 011, idempotente) + política
--   RLS de UPDATE (public, true) para el panel admin (etapa H).
-- - crear_desafio(): valida TODO server-side y crea el challenge (regla 3):
--   1 activo por jugador (ambos lados), rango <= max_puestos, challenged más
--   arriba, no lesionado; WildCard sin límite de rango (marca wildcard_usada);
--   si el challenger estaba lesionado, lo reactiva (+ fila reactivacion).
-- =====================================================================

-- ── ranking_log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ranking_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  player_id    uuid REFERENCES public.players(id),
  causa        text NOT NULL,          -- 'resultado' | 'inactividad' | 'reactivacion' | 'admin'
  detalle      text,
  desde        integer,                -- posición antes
  hasta        integer,                -- posición después
  challenge_id uuid REFERENCES public.challenges(id)
);
ALTER TABLE public.ranking_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ranking_log_read ON public.ranking_log;
CREATE POLICY ranking_log_read ON public.ranking_log FOR SELECT USING (true);

-- ── v2_config: columna (idempotente) + política de UPDATE ────────────
ALTER TABLE v2_config ADD COLUMN IF NOT EXISTS max_puestos_desafio integer NOT NULL DEFAULT 4;
-- Reglamento: el rango máximo de desafío es 4 puestos hacia arriba (configurable;
-- tendrá panel en la etapa H). El ALTER IF NOT EXISTS no cambia el valor de una
-- columna preexistente, así que lo fijamos explícitamente al aplicar la 016.
UPDATE v2_config SET max_puestos_desafio = 4 WHERE id = 1;
DROP POLICY IF EXISTS v2_config_update ON v2_config;
CREATE POLICY v2_config_update ON v2_config FOR UPDATE USING (true) WITH CHECK (true);

-- ── aplicar_resultado: + auditoría en ranking_log (incl. 'por WO') ────
CREATE OR REPLACE FUNCTION public.aplicar_resultado(p_challenge_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c         challenges%ROWTYPE;
  win_id    uuid;
  lose_id   uuid;
  pos_win   integer;
  pos_lose  integer;
  movio     boolean := false;
  snap      jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Desafío no encontrado: %', p_challenge_id;
  END IF;

  IF c.ranking_applied THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ya_aplicado');
  END IF;

  IF c.status <> 'completed' OR c.ganador IS NULL THEN
    RAISE EXCEPTION 'El desafío no tiene resultado completo (status=%, ganador=%)', c.status, c.ganador;
  END IF;

  IF c.ganador = 'challenger' THEN
    win_id  := c.challenger_id;  lose_id := c.challenged_id;
  ELSIF c.ganador = 'challenged' THEN
    win_id  := c.challenged_id;  lose_id := c.challenger_id;
  ELSE
    RAISE EXCEPTION 'Valor de ganador inválido: %', c.ganador;
  END IF;

  SELECT posicion INTO pos_win  FROM players WHERE id = win_id;
  SELECT posicion INTO pos_lose FROM players WHERE id = lose_id;

  IF pos_win IS NULL OR pos_lose IS NULL THEN
    RAISE EXCEPTION 'Uno de los jugadores no tiene posición en el ranking';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', id, 'posicion', posicion,
           'semanas_inactivo', semanas_inactivo,
           'ultima_fecha_jugada', ultima_fecha_jugada,
           'lesionado', lesionado))
  INTO snap
  FROM players WHERE activo = true AND posicion IS NOT NULL;

  IF pos_lose < pos_win THEN
    UPDATE players
    SET posicion = posicion + 1
    WHERE activo = true
      AND posicion >= pos_lose
      AND posicion <  pos_win;

    UPDATE players SET posicion = pos_lose WHERE id = win_id;
    movio := true;
  END IF;

  PERFORM recalcular_stats(win_id, lose_id);

  UPDATE players
  SET ultima_fecha_jugada = now(),
      semanas_inactivo    = 0,
      dias_inactivo       = 0,
      lesionado           = false,
      lesion_nota         = '',
      lesion_fecha        = NULL
  WHERE id IN (win_id, lose_id);

  UPDATE challenges
  SET ranking_applied = true,
      snapshot_pre    = snap,
      applied_at      = now()
  WHERE id = p_challenge_id;

  -- Auditoría: ganador + desplazados (incl. perdedor). 'por WO' si is_wo.
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta, challenge_id)
  VALUES (win_id, 'resultado',
          CASE WHEN c.is_wo THEN 'gana por WO' ELSE 'gana el partido' END,
          pos_win, CASE WHEN movio THEN pos_lose ELSE pos_win END, p_challenge_id);

  IF movio THEN
    INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta, challenge_id)
    SELECT id, 'resultado',
           CASE WHEN id = lose_id
                THEN (CASE WHEN c.is_wo THEN 'baja por WO' ELSE 'pierde el partido' END)
                ELSE 'desplazado por ascenso' END,
           posicion - 1, posicion, p_challenge_id
    FROM players
    WHERE activo AND posicion > pos_lose AND posicion <= pos_win AND id <> win_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'movio_ranking', movio,
    'ganador_id', win_id,
    'perdedor_id', lose_id,
    'posicion_ganador_antes', pos_win,
    'posicion_ganador_ahora', CASE WHEN movio THEN pos_lose ELSE pos_win END
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'aplicar_resultado falló: %', SQLERRM;
END;
$function$
;

-- ── cron_diario: + auditoría en ranking_log (inactividad) ────────────
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

  -- 1) EXPIRAR DESAFÍOS (relojes se reanudan solos al no quedar agendados)
  UPDATE challenges
     SET status = 'expired'
   WHERE status IN ('pending','accepted')
     AND created_at + make_interval(days => v_dias_exp) < now();
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

-- ── crear_desafio: valida reglas y crea el challenge ─────────────────
CREATE OR REPLACE FUNCTION public.crear_desafio(
  p_challenger  uuid,
  p_challenged  uuid,
  p_is_wildcard boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ch         players%ROWTYPE;
  cd         players%ROWTYPE;
  v_max      integer;
  v_dias_exp integer;
  v_cid      uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  IF p_challenger = p_challenged THEN
    RAISE EXCEPTION 'No puedes desafiarte a ti mismo';
  END IF;

  SELECT * INTO ch FROM players WHERE id = p_challenger;
  SELECT * INTO cd FROM players WHERE id = p_challenged;

  IF ch.id IS NULL OR NOT ch.activo OR ch.posicion IS NULL THEN
    RAISE EXCEPTION 'El desafiante no está activo en el ranking';
  END IF;
  IF cd.id IS NULL OR NOT cd.activo OR cd.posicion IS NULL THEN
    RAISE EXCEPTION 'El rival no está activo en el ranking';
  END IF;

  -- 1 desafío activo por jugador (ambos lados)
  IF EXISTS (SELECT 1 FROM challenges
              WHERE status IN ('pending','accepted')
                AND (challenger_id = p_challenger OR challenged_id = p_challenger)) THEN
    RAISE EXCEPTION '% ya tiene un desafío activo', ch.nombre || ' ' || ch.apellido;
  END IF;
  IF EXISTS (SELECT 1 FROM challenges
              WHERE status IN ('pending','accepted')
                AND (challenger_id = p_challenged OR challenged_id = p_challenged)) THEN
    RAISE EXCEPTION '% ya tiene un desafío activo', cd.nombre || ' ' || cd.apellido;
  END IF;

  -- El desafiado no puede estar lesionado
  IF cd.lesionado THEN
    RAISE EXCEPTION '% está lesionado y no puede ser desafiado', cd.nombre || ' ' || cd.apellido;
  END IF;

  -- El desafiado debe estar más arriba (menor posición)
  IF NOT (cd.posicion < ch.posicion) THEN
    RAISE EXCEPTION 'Solo puedes desafiar a alguien más arriba en el ranking';
  END IF;

  -- Rango (salvo WildCard)
  IF p_is_wildcard THEN
    IF ch.wildcard_usada THEN
      RAISE EXCEPTION 'Ya usaste tu WildCard';
    END IF;
  ELSE
    SELECT max_puestos_desafio INTO v_max FROM v2_config WHERE id = 1;
    IF cd.posicion < ch.posicion - v_max THEN
      RAISE EXCEPTION 'Solo puedes desafiar hasta % puestos hacia arriba', v_max;
    END IF;
  END IF;

  -- Reactivación: crear un desafío saca al challenger de lesión
  IF ch.lesionado THEN
    UPDATE players SET lesionado = false, lesion_nota = '', lesion_fecha = NULL
     WHERE id = p_challenger;
    INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
    VALUES (p_challenger, 'reactivacion', 'vuelve de lesión al crear desafío', ch.posicion, ch.posicion);
  END IF;

  SELECT COALESCE(dias_expiracion_desafio, 7) INTO v_dias_exp FROM v2_config WHERE id = 1;

  INSERT INTO challenges (challenger_id, challenged_id, status, deadline, is_wildcard)
  VALUES (p_challenger, p_challenged, 'pending', current_date + v_dias_exp, p_is_wildcard)
  RETURNING id INTO v_cid;

  IF p_is_wildcard THEN
    UPDATE players SET wildcard_usada = true WHERE id = p_challenger;
  END IF;

  RETURN jsonb_build_object('ok', true, 'challenge_id', v_cid);
END;
$function$
;
