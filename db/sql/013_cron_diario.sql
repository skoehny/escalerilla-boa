-- V2 — Migración 013: cron_diario() (inactividad definitiva) + soporte
-- =====================================================================
-- Reglas (definitivas):
--  1. PAUSA: un desafío pending/accepted pausa el reloj de AMBOS jugadores.
--     Al expirar/cancelarse sin resultado, el reloj se reanuda donde iba
--     (los días en pausa no se cuentan, sin recuperación).
--  2. CONTADOR: players.dias_inactivo. El cron suma +1/día a cada activo SIN
--     desafío pending/accepted y SIN resultado ese día. Un resultado lo deja
--     en 0 (aplicar_resultado). Dato inicial: dias_inactivo = semanas_inactivo*7.
--     semanas_inactivo se mantiene sincronizado = floor(dias_inactivo/7) (UI badge).
--  3. PENALIZACIONES: al CRUZAR HOY el umbral exacto de días efectivos:
--       14 => -2 puestos ; 21 => -1 ; 28 => -1 + lesionado ; cada 7 más (35,42..) => -1.
--     "Cruzar" = el incremento de hoy dejó el contador justo en ese valor
--     (no se re-penaliza valores que ya traía; los migrados en múltiplos de 7
--     no caen exactamente en 14/21/28 en la 1ª corrida, así que no hay retro).
--     Mecánica: el penalizado baja N, los de abajo suben 1 (inversa de
--     aplicar_resultado). Se procesan de ABAJO hacia ARRIBA (posición mayor
--     primero). FRENO: nunca queda debajo de otro con dias_inactivo>=14 ni de
--     un debutante (victorias=0 y derrotas=0); se detiene justo encima.
--  4. CONVIVENCIA: todo corre con pg_advisory_xact_lock(hashtext('aplicar_resultado')).
--     Si movió posiciones, sella v2_config.last_cron_movement_at=now(). En
--     corregir_resultado (no admin) se bloquea si hubo cron posterior al applied_at.
--  5. LESIONADO: el cron solo setea el flag a los 28 días. Mismo campo que el
--     flag manual del admin. (Quitar lesionado al agendar es lógica de UI: TODO.)
--  6. EXPIRACIÓN: expira pending/accepted con created_at + dias_expiracion < now().
--
-- Idempotencia diaria: v2_config.last_cron_daily_date. Si ya corrió hoy (UTC),
-- retorna sin hacer nada. Para tests/manual se puede invocar SELECT cron_diario()
-- ajustando last_cron_daily_date para simular días sucesivos.
--
-- SCHEDULING: se programa a las 08:00 UTC (05:00 Chile en invierno / 04:00 en
-- verano — hora muerta en ambos casos).
--   Pausar durante desarrollo:   SELECT cron.unschedule('v2_cron_diario');
--   Reanudar:                     SELECT cron.schedule('v2_cron_diario','0 8 * * *',
--                                        $$SELECT public.cron_diario();$$);
--   Correr a mano hoy:            UPDATE v2_config SET last_cron_daily_date=NULL WHERE id=1;
--                                 SELECT public.cron_diario();
-- =====================================================================

-- ── Columnas ──────────────────────────────────────────────────────────
ALTER TABLE players   ADD COLUMN IF NOT EXISTS dias_inactivo integer NOT NULL DEFAULT 0;
ALTER TABLE v2_config ADD COLUMN IF NOT EXISTS last_cron_movement_at timestamptz;
ALTER TABLE v2_config ADD COLUMN IF NOT EXISTS last_cron_daily_date  date;

-- ── Dato inicial (una vez): dias_inactivo = semanas_inactivo * 7 ──────
UPDATE players
   SET dias_inactivo = semanas_inactivo * 7
 WHERE dias_inactivo = 0 AND semanas_inactivo > 0;

-- ── aplicar_resultado: además de semanas/ultima_fecha, resetea dias_inactivo ──
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

-- ── corregir_resultado: bloquea a NO admin si hubo movimiento de cron posterior ──
CREATE OR REPLACE FUNCTION public.corregir_resultado(
  p_challenge_id uuid,
  p_editor_id    uuid,
  p_score_a      integer,
  p_score_b      integer,
  p_tiebreak_a   integer DEFAULT NULL,
  p_tiebreak_b   integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c            challenges%ROWTYPE;
  ventana_min  integer;
  ultimo_id    uuid;
  es_admin     boolean;
  v_last_cron  timestamptz;
  res          jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF NOT c.ranking_applied THEN RAISE EXCEPTION 'El resultado aún no está aplicado'; END IF;

  SELECT COALESCE(p.es_admin, false) INTO es_admin FROM players p WHERE p.id = p_editor_id;

  IF NOT es_admin THEN
    IF p_editor_id NOT IN (c.challenger_id, c.challenged_id) THEN
      RAISE EXCEPTION 'Solo los jugadores del partido pueden corregir';
    END IF;
    IF c.resultado_validado THEN
      RAISE EXCEPTION 'Resultado ya validado: solo el admin puede corregirlo';
    END IF;
    -- Movimientos de ranking del cron posteriores a la aplicación de este resultado
    SELECT last_cron_movement_at INTO v_last_cron FROM v2_config WHERE id = 1;
    IF v_last_cron IS NOT NULL AND c.applied_at IS NOT NULL AND v_last_cron > c.applied_at THEN
      RAISE EXCEPTION 'Hubo movimientos de ranking posteriores: solo el admin puede corregir';
    END IF;
    SELECT ventana_validacion_minutos INTO ventana_min FROM v2_config WHERE id = 1;
    IF c.resultado_ingresado_at IS NOT NULL
       AND now() > c.resultado_ingresado_at + make_interval(mins => ventana_min) THEN
      RAISE EXCEPTION 'Ventana de corrección vencida: solo el admin puede corregirlo';
    END IF;
  END IF;

  SELECT id INTO ultimo_id FROM challenges
  WHERE ranking_applied = true AND applied_at IS NOT NULL
  ORDER BY applied_at DESC LIMIT 1;
  IF ultimo_id IS DISTINCT FROM c.id THEN
    RAISE EXCEPTION 'Ya se aplicaron otros partidos después: solo el admin puede corregir manualmente';
  END IF;

  IF p_score_a IS NULL OR p_score_b IS NULL OR p_score_a = p_score_b
     OR GREATEST(p_score_a, p_score_b) <> 9
     OR LEAST(p_score_a, p_score_b) < 0 THEN
    RAISE EXCEPTION 'Marcador inválido: debe ser 9 a X';
  END IF;

  IF c.snapshot_pre IS NULL THEN
    RAISE EXCEPTION 'Este desafío no tiene foto de reversión: corregir vía admin';
  END IF;

  UPDATE players p
  SET posicion            = (j->>'posicion')::integer,
      semanas_inactivo    = (j->>'semanas_inactivo')::integer,
      ultima_fecha_jugada = NULLIF(j->>'ultima_fecha_jugada','')::timestamp,
      lesionado           = (j->>'lesionado')::boolean
  FROM jsonb_array_elements(c.snapshot_pre) AS j
  WHERE p.id = (j->>'id')::uuid;

  UPDATE challenges
  SET score_a = p_score_a,
      score_b = p_score_b,
      tiebreak_a = p_tiebreak_a,
      tiebreak_b = p_tiebreak_b,
      ganador = CASE WHEN p_score_a > p_score_b THEN 'challenger' ELSE 'challenged' END,
      ranking_applied = false,
      resultado_validado = false,
      validado_por = NULL,
      anotado_por = p_editor_id,
      snapshot_pre = NULL,
      applied_at = NULL
  WHERE id = p_challenge_id;

  res := aplicar_resultado(p_challenge_id);

  RETURN jsonb_build_object('ok', true, 'reaplicado', res);

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'corregir_resultado falló: %', SQLERRM;
END;
$function$
;

-- ── cron_diario ───────────────────────────────────────────────────────
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

  -- 3) INCREMENTO: +1 a activos sin pausa y sin resultado hoy.
  --    (Nota: por spec 'cada activo' incluye debutantes; el freno los protege
  --     solo como piso, no de su propio conteo.)
  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND p.id NOT IN (SELECT pid FROM _paused)
       AND (p.ultima_fecha_jugada IS NULL OR p.ultima_fecha_jugada::date < v_today);

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

-- ── Programar a las 08:00 UTC (idempotente) ──────────────────────────
SELECT cron.unschedule('v2_cron_diario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'v2_cron_diario');

SELECT cron.schedule('v2_cron_diario', '0 8 * * *', $$SELECT public.cron_diario();$$);
