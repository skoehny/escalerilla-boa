-- =====================================================================
-- CUTOVER 01 — MIGRACIONES v2 (concatenación literal de db/sql/)
-- Orden: 010,011,012,013,014,016,017,018,019,020,021,022,023,024 (no existe 015).
-- Contenido IDÉNTICO a los archivos fuente (no editar). Ejecutar DESPUÉS de
-- cutover_00_prereqs.sql y de verificar la PRE-FLIGHT (ver cutover_README.md).
-- Los archivos 012/013/014 crean la extensión pg_cron y AGENDAN los 3 crons.
-- =====================================================================

-- ============ MIGRACIÓN 010: validar_corregir ============

-- V2 — APLICACIÓN INSTANTÁNEA + VALIDAR / CORREGIR

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS snapshot_pre jsonb;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS applied_at timestamptz;

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

CREATE OR REPLACE FUNCTION public.validar_resultado(p_challenge_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c challenges%ROWTYPE;
BEGIN
  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF c.ganador IS NULL THEN RAISE EXCEPTION 'El desafío no tiene resultado'; END IF;
  IF p_player_id NOT IN (c.challenger_id, c.challenged_id) THEN
    RAISE EXCEPTION 'Solo los jugadores del partido pueden validar';
  END IF;

  UPDATE challenges
  SET resultado_validado = true,
      validado_por = p_player_id
  WHERE id = p_challenge_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

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


-- ============ MIGRACIÓN 011: max_puestos_desafio ============

-- V2 — Rango máximo de desafío configurable (regla 3)
-- Cambio de reglamento: el alcance máximo pasa de 5 a 4 puestos hacia arriba.
-- La validación al crear un desafío debe leer este valor (no un número fijo).
-- El WildCard queda exento de este límite.

ALTER TABLE v2_config
  ADD COLUMN IF NOT EXISTS max_puestos_desafio integer NOT NULL DEFAULT 4;


-- ============ MIGRACIÓN 012: cron_aplicar_pendientes ============

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


-- ============ MIGRACIÓN 013: cron_diario ============

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
--     DEBUTANTES (victorias=0 y derrotas=0) NO tienen reloj: se excluyen del
--     incremento (y por tanto de penalización y lesionado) hasta su 1er resultado.
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

-- Debutantes (v=0 y d=0) NO tienen reloj: dias_inactivo=0 aunque semanas*7 dijera otra cosa.
UPDATE players
   SET dias_inactivo = 0
 WHERE COALESCE(victorias,0) = 0 AND COALESCE(derrotas,0) = 0 AND dias_inactivo <> 0;

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


-- ============ MIGRACIÓN 014: foto_jueves ============

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


-- ============ MIGRACIÓN 016: crear_desafio ============

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


-- ============ MIGRACIÓN 017: wo ============

-- V2 — Migración 017 (ETAPA G): WO (walkover)
-- =====================================================================
-- - challenges.cancelled_at / cancelled_by: quién y cuándo canceló (para
--   detectar cancelación tardía y habilitar el WO al afectado).
-- - validar_resultado: anti-auto-validación GLOBAL — el que anotó NO puede
--   validar su propio resultado (solo el rival valida; el anotador corrige).
-- - marcar_wo(): RPC que aplica ambos flujos de WO y llama aplicar_resultado
--   (que ya loguea 'por WO' en ranking_log e incrementa stats normalmente).
--     A) WO sin slot: desafío pending/accepted sin cancha -> lo marca cualquiera
--        de los dos; gana el que marca 9-0.
--     B) WO por cancelación tardía: desafío cancelado (cancelled_at) que tenía
--        cancha y se canceló a < horas_wo_cancelacion del slot -> lo marca el
--        AFECTADO (no quien canceló); gana el afectado 9-0.
-- =====================================================================

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES players(id);

-- ── validar_resultado: + anti-auto-validación ───────────────────────
CREATE OR REPLACE FUNCTION public.validar_resultado(p_challenge_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c challenges%ROWTYPE;
BEGIN
  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF c.ganador IS NULL THEN RAISE EXCEPTION 'El desafío no tiene resultado'; END IF;
  IF p_player_id NOT IN (c.challenger_id, c.challenged_id) THEN
    RAISE EXCEPTION 'Solo los jugadores del partido pueden validar';
  END IF;
  -- Anti-auto-validación: quien anotó el resultado no puede validarlo.
  IF c.anotado_por IS NOT NULL AND p_player_id = c.anotado_por THEN
    RAISE EXCEPTION 'Quien anotó el resultado no puede validarlo; debe validarlo el rival';
  END IF;

  UPDATE challenges
  SET resultado_validado = true,
      validado_por = p_player_id
  WHERE id = p_challenge_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

-- ── marcar_wo ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.marcar_wo(p_challenge_id uuid, p_marker_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c           challenges%ROWTYPE;
  v_horas     integer;
  v_slot_ts   timestamptz;
  v_side      text;
  v_tardia    boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF p_marker_id NOT IN (c.challenger_id, c.challenged_id) THEN
    RAISE EXCEPTION 'Solo los jugadores del partido pueden marcar WO';
  END IF;

  IF c.status IN ('pending', 'accepted') THEN
    -- A) WO sin slot fijado: lo marca cualquiera; gana el que marca.
    IF c.slot_day IS NOT NULL AND c.slot_court IS NOT NULL AND c.slot_hour IS NOT NULL THEN
      RAISE EXCEPTION 'Este desafío tiene cancha reservada: el WO se habilita al cancelar tarde';
    END IF;

  ELSIF c.status = 'expired' AND c.cancelled_at IS NOT NULL THEN
    -- B) WO por cancelación tardía: requiere cancha y estar dentro del umbral.
    IF c.slot_day IS NULL OR c.slot_hour IS NULL THEN
      RAISE EXCEPTION 'La cancelación no tenía cancha reservada: no aplica WO';
    END IF;
    v_slot_ts := ((c.slot_day || ' ' || c.slot_hour)::timestamp) AT TIME ZONE 'America/Santiago';
    SELECT COALESCE(horas_wo_cancelacion, 24) INTO v_horas FROM v2_config WHERE id = 1;
    IF c.cancelled_at <= v_slot_ts - make_interval(hours => v_horas) THEN
      RAISE EXCEPTION 'La cancelación fue con más de % h de anticipación: no aplica WO', v_horas;
    END IF;
    IF p_marker_id = c.cancelled_by THEN
      RAISE EXCEPTION 'Quien canceló no puede marcar el WO; lo marca el jugador afectado';
    END IF;
    v_tardia := true;

  ELSE
    RAISE EXCEPTION 'Este desafío no admite WO en su estado actual';
  END IF;

  IF p_marker_id = c.challenger_id THEN v_side := 'challenger'; ELSE v_side := 'challenged'; END IF;

  UPDATE challenges SET
    status             = 'completed',
    is_wo              = true,
    score_a            = CASE WHEN v_side = 'challenger' THEN 9 ELSE 0 END,
    score_b            = CASE WHEN v_side = 'challenger' THEN 0 ELSE 9 END,
    ganador            = v_side,
    anotado_por        = p_marker_id,
    ranking_applied    = false,
    resultado_validado = false,
    validado_por       = NULL,
    snapshot_pre       = NULL,
    applied_at         = NULL
  WHERE id = p_challenge_id;   -- el trigger estampa resultado_ingresado_at=now()

  PERFORM aplicar_resultado(p_challenge_id);

  RETURN jsonb_build_object('ok', true, 'tardia', v_tardia, 'ganador', v_side);
END;
$function$
;


-- ============ MIGRACIÓN 018: admin_tools ============

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


-- ============ MIGRACIÓN 019: marcar_wo_admin ============

-- V2 — Migración 019: override admin en marcar_wo
-- =====================================================================
-- El admin puede declarar WO sobre cualquier desafío no jugado (pending/accepted
-- o cancelado), incluso con cancha reservada — es una anulación administrativa,
-- no el flujo de jugador. Se agrega p_admin_override (default false):
--   - false (jugador): reglas de siempre (sin slot, o cancelación tardía).
--   - true  (admin):   saltea guards de slot/estado; solo exige que el marker
--                      sea uno de los 2 jugadores y que el desafío no esté ya
--                      jugado (completed -> usar Corregir).
-- En ambos casos gana 9-0 el marker y se aplica vía aplicar_resultado (loguea
-- 'por WO', mueve ranking, cuenta stats).
-- =====================================================================

-- La firma nueva agrega un parámetro (con default): CREATE OR REPLACE crearía un
-- OVERLOAD y las llamadas de 2 args quedarían ambiguas. Dropeamos la firma vieja.
DROP FUNCTION IF EXISTS public.marcar_wo(uuid, uuid);

CREATE OR REPLACE FUNCTION public.marcar_wo(
  p_challenge_id  uuid,
  p_marker_id     uuid,
  p_admin_override boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c           challenges%ROWTYPE;
  v_horas     integer;
  v_slot_ts   timestamptz;
  v_side      text;
  v_tardia    boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF p_marker_id NOT IN (c.challenger_id, c.challenged_id) THEN
    RAISE EXCEPTION 'Solo los jugadores del partido pueden marcar WO';
  END IF;

  IF p_admin_override THEN
    -- Anulación admin: saltea guards de slot/cancelación. Solo veta ya jugados.
    IF c.status = 'completed' THEN
      RAISE EXCEPTION 'El desafío ya tiene resultado: usá Corregir';
    END IF;

  ELSIF c.status IN ('pending', 'accepted') THEN
    -- A) WO sin slot fijado: lo marca cualquiera; gana el que marca.
    IF c.slot_day IS NOT NULL AND c.slot_court IS NOT NULL AND c.slot_hour IS NOT NULL THEN
      RAISE EXCEPTION 'Este desafío tiene cancha reservada: el WO se habilita al cancelar tarde';
    END IF;

  ELSIF c.status = 'expired' AND c.cancelled_at IS NOT NULL THEN
    -- B) WO por cancelación tardía: requiere cancha y estar dentro del umbral.
    IF c.slot_day IS NULL OR c.slot_hour IS NULL THEN
      RAISE EXCEPTION 'La cancelación no tenía cancha reservada: no aplica WO';
    END IF;
    v_slot_ts := ((c.slot_day || ' ' || c.slot_hour)::timestamp) AT TIME ZONE 'America/Santiago';
    SELECT COALESCE(horas_wo_cancelacion, 24) INTO v_horas FROM v2_config WHERE id = 1;
    IF c.cancelled_at <= v_slot_ts - make_interval(hours => v_horas) THEN
      RAISE EXCEPTION 'La cancelación fue con más de % h de anticipación: no aplica WO', v_horas;
    END IF;
    IF p_marker_id = c.cancelled_by THEN
      RAISE EXCEPTION 'Quien canceló no puede marcar el WO; lo marca el jugador afectado';
    END IF;
    v_tardia := true;

  ELSE
    RAISE EXCEPTION 'Este desafío no admite WO en su estado actual';
  END IF;

  IF p_marker_id = c.challenger_id THEN v_side := 'challenger'; ELSE v_side := 'challenged'; END IF;

  UPDATE challenges SET
    status             = 'completed',
    is_wo              = true,
    score_a            = CASE WHEN v_side = 'challenger' THEN 9 ELSE 0 END,
    score_b            = CASE WHEN v_side = 'challenger' THEN 0 ELSE 9 END,
    ganador            = v_side,
    anotado_por        = p_marker_id,
    ranking_applied    = false,
    resultado_validado = false,
    validado_por       = NULL,
    snapshot_pre       = NULL,
    applied_at         = NULL
  WHERE id = p_challenge_id;   -- el trigger estampa resultado_ingresado_at=now()

  PERFORM aplicar_resultado(p_challenge_id);

  RETURN jsonb_build_object('ok', true, 'tardia', v_tardia, 'ganador', v_side, 'admin', p_admin_override);
END;
$function$
;


-- ============ MIGRACIÓN 020: nombre_club ============

-- V2 — Migración 020: nombre del club configurable
-- El nombre de la sede/club deja de estar hardcodeado ("Club BOA"); el admin lo
-- edita desde el panel Configuración v2. La UI (login, reglamento) e invitaciones
-- lo leen de acá. Default = 'Club BOA' para preservar el valor actual.

ALTER TABLE v2_config
  ADD COLUMN IF NOT EXISTS nombre_club text NOT NULL DEFAULT 'Club BOA';


-- ============ MIGRACIÓN 021: formato_partido ============

-- V2 — Migración 021 (ETAPA J): formato de partido configurable
-- =====================================================================
-- Tres formatos (global, elegido por admin; aplica a partidos nuevos):
--   set9:     1 set a 9  → 9-N (N≤7) o 9-8 (tiebreak al 8-8).
--   set6:     1 set a 6  → 6-N (N≤4), 7-5, o 7-6 (tiebreak al 6-6).
--   dos_sets: 2 sets a 6 (cada uno set6-style); si 1-1, super tiebreak a 7 con
--             dif de 2 (7-5 sí, 7-6 no → 8-6, 9-7…), guardado como 3er set.
-- challenges.sets jsonb = [{a,b},{a,b},{a,b}] (games por set; el 3ro en dos_sets
--   son puntos del super tiebreak). score_a/score_b = games del set (1 set) o
--   SETS GANADOS (dos_sets, 2-0/2-1). Ganador se deriva igual que siempre.
-- =====================================================================

ALTER TABLE v2_config
  ADD COLUMN IF NOT EXISTS formato_partido text NOT NULL DEFAULT 'set9'
  CHECK (formato_partido IN ('set9','set6','dos_sets'));

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS sets jsonb;

-- ── helper: ganador de un set "a 6" (set6-style) o NULL si inválido ──
CREATE OR REPLACE FUNCTION public._set6_winner(a integer, b integer)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL OR a = b THEN NULL
    WHEN (GREATEST(a,b) = 6 AND LEAST(a,b) <= 4)
      OR (GREATEST(a,b) = 7 AND LEAST(a,b) IN (5,6))
      THEN CASE WHEN a > b THEN 'a' ELSE 'b' END
    ELSE NULL
  END
$function$;

-- ── validar_marcador: la ley del marcador. {ok, ganador('a'|'b'), score_a, score_b, error} ──
CREATE OR REPLACE FUNCTION public.validar_marcador(p_formato text, p_sets jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $function$
DECLARE
  n int; a int; b int; hi int; lo int; w text; wa int := 0; wb int := 0; i int;
BEGIN
  IF p_sets IS NULL OR jsonb_typeof(p_sets) <> 'array' OR jsonb_array_length(p_sets) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Faltan los sets');
  END IF;
  n := jsonb_array_length(p_sets);

  IF p_formato = 'set9' THEN
    IF n <> 1 THEN RETURN jsonb_build_object('ok',false,'error','Formato de 1 set: debe ir un solo set'); END IF;
    a := (p_sets->0->>'a')::int; b := (p_sets->0->>'b')::int;
    IF a IS NULL OR b IS NULL OR a = b THEN RETURN jsonb_build_object('ok',false,'error','Marcador inválido'); END IF;
    hi := GREATEST(a,b); lo := LEAST(a,b);
    IF hi <> 9 OR lo < 0 OR lo > 8 THEN
      RETURN jsonb_build_object('ok',false,'error','Set a 9: 9-N con N≤7, o 9-8');
    END IF;
    RETURN jsonb_build_object('ok',true,'ganador',CASE WHEN a>b THEN 'a' ELSE 'b' END,'score_a',a,'score_b',b);

  ELSIF p_formato = 'set6' THEN
    IF n <> 1 THEN RETURN jsonb_build_object('ok',false,'error','Formato de 1 set: debe ir un solo set'); END IF;
    a := (p_sets->0->>'a')::int; b := (p_sets->0->>'b')::int;
    w := _set6_winner(a,b);
    IF w IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Set a 6: 6-N con N≤4, 7-5 o 7-6'); END IF;
    RETURN jsonb_build_object('ok',true,'ganador',w,'score_a',a,'score_b',b);

  ELSIF p_formato = 'dos_sets' THEN
    IF n < 2 OR n > 3 THEN RETURN jsonb_build_object('ok',false,'error','2 sets a 6: deben ir 2 o 3 sets'); END IF;
    FOR i IN 0..1 LOOP
      a := (p_sets->i->>'a')::int; b := (p_sets->i->>'b')::int;
      w := _set6_winner(a,b);
      IF w IS NULL THEN
        RETURN jsonb_build_object('ok',false,'error','Set '||(i+1)||' inválido (a 6: 6-N N≤4, 7-5, 7-6)');
      END IF;
      IF w = 'a' THEN wa := wa+1; ELSE wb := wb+1; END IF;
    END LOOP;

    IF wa = 2 OR wb = 2 THEN
      IF n <> 2 THEN RETURN jsonb_build_object('ok',false,'error','Ya está 2-0: no debe haber tercer set'); END IF;
      RETURN jsonb_build_object('ok',true,'ganador',CASE WHEN wa=2 THEN 'a' ELSE 'b' END,'score_a',wa,'score_b',wb);
    ELSE
      IF n <> 3 THEN RETURN jsonb_build_object('ok',false,'error','Va 1-1: falta el super tiebreak (tercer set)'); END IF;
      a := (p_sets->2->>'a')::int; b := (p_sets->2->>'b')::int;
      IF a IS NULL OR b IS NULL OR a = b THEN RETURN jsonb_build_object('ok',false,'error','Super tiebreak inválido'); END IF;
      hi := GREATEST(a,b); lo := LEAST(a,b);
      IF NOT ((hi = 7 AND lo <= 5) OR (hi >= 8 AND hi - lo = 2 AND lo >= 6)) THEN
        RETURN jsonb_build_object('ok',false,'error','Super tiebreak: a 7 con dif de 2 (7-5 sí, 7-6 no; sigue 8-6, 9-7…)');
      END IF;
      IF a > b THEN wa := wa+1; ELSE wb := wb+1; END IF;
      RETURN jsonb_build_object('ok',true,'ganador',CASE WHEN a>b THEN 'a' ELSE 'b' END,'score_a',wa,'score_b',wb);
    END IF;

  ELSE
    RETURN jsonb_build_object('ok',false,'error','Formato desconocido');
  END IF;
END;
$function$;

-- ── marcar_wo: score/sets del WO según el formato vigente ────────────
CREATE OR REPLACE FUNCTION public.marcar_wo(p_challenge_id uuid, p_marker_id uuid, p_admin_override boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c           challenges%ROWTYPE;
  v_horas     integer;
  v_slot_ts   timestamptz;
  v_side      text;
  v_tardia    boolean := false;
  v_formato   text;
  win_a       boolean;
  v_sa        integer;
  v_sb        integer;
  v_sets      jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT * INTO c FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado'; END IF;
  IF p_marker_id NOT IN (c.challenger_id, c.challenged_id) THEN
    RAISE EXCEPTION 'Solo los jugadores del partido pueden marcar WO';
  END IF;

  IF p_admin_override THEN
    IF c.status = 'completed' THEN
      RAISE EXCEPTION 'El desafío ya tiene resultado: usá Corregir';
    END IF;
  ELSIF c.status IN ('pending', 'accepted') THEN
    IF c.slot_day IS NOT NULL AND c.slot_court IS NOT NULL AND c.slot_hour IS NOT NULL THEN
      RAISE EXCEPTION 'Este desafío tiene cancha reservada: el WO se habilita al cancelar tarde';
    END IF;
  ELSIF c.status = 'expired' AND c.cancelled_at IS NOT NULL THEN
    IF c.slot_day IS NULL OR c.slot_hour IS NULL THEN
      RAISE EXCEPTION 'La cancelación no tenía cancha reservada: no aplica WO';
    END IF;
    v_slot_ts := ((c.slot_day || ' ' || c.slot_hour)::timestamp) AT TIME ZONE 'America/Santiago';
    SELECT COALESCE(horas_wo_cancelacion, 24) INTO v_horas FROM v2_config WHERE id = 1;
    IF c.cancelled_at <= v_slot_ts - make_interval(hours => v_horas) THEN
      RAISE EXCEPTION 'La cancelación fue con más de % h de anticipación: no aplica WO', v_horas;
    END IF;
    IF p_marker_id = c.cancelled_by THEN
      RAISE EXCEPTION 'Quien canceló no puede marcar el WO; lo marca el jugador afectado';
    END IF;
    v_tardia := true;
  ELSE
    RAISE EXCEPTION 'Este desafío no admite WO en su estado actual';
  END IF;

  IF p_marker_id = c.challenger_id THEN v_side := 'challenger'; ELSE v_side := 'challenged'; END IF;
  win_a := (v_side = 'challenger');

  SELECT COALESCE(formato_partido, 'set9') INTO v_formato FROM v2_config WHERE id = 1;

  IF v_formato = 'set6' THEN
    IF win_a THEN v_sa:=6; v_sb:=0; v_sets:=jsonb_build_array(jsonb_build_object('a',6,'b',0));
    ELSE          v_sa:=0; v_sb:=6; v_sets:=jsonb_build_array(jsonb_build_object('a',0,'b',6)); END IF;
  ELSIF v_formato = 'dos_sets' THEN
    IF win_a THEN v_sa:=2; v_sb:=0; v_sets:=jsonb_build_array(jsonb_build_object('a',6,'b',0),jsonb_build_object('a',6,'b',0));
    ELSE          v_sa:=0; v_sb:=2; v_sets:=jsonb_build_array(jsonb_build_object('a',0,'b',6),jsonb_build_object('a',0,'b',6)); END IF;
  ELSE  -- set9
    IF win_a THEN v_sa:=9; v_sb:=0; v_sets:=jsonb_build_array(jsonb_build_object('a',9,'b',0));
    ELSE          v_sa:=0; v_sb:=9; v_sets:=jsonb_build_array(jsonb_build_object('a',0,'b',9)); END IF;
  END IF;

  UPDATE challenges SET
    status             = 'completed',
    is_wo              = true,
    score_a            = v_sa,
    score_b            = v_sb,
    sets               = v_sets,
    ganador            = v_side,
    anotado_por        = p_marker_id,
    ranking_applied    = false,
    resultado_validado = false,
    validado_por       = NULL,
    snapshot_pre       = NULL,
    applied_at         = NULL
  WHERE id = p_challenge_id;

  PERFORM aplicar_resultado(p_challenge_id);

  RETURN jsonb_build_object('ok', true, 'tardia', v_tardia, 'ganador', v_side, 'admin', p_admin_override);
END;
$function$;

-- ── corregir_resultado: + p_sets jsonb; valida vía validar_marcador ──
-- (dropear firma vieja para no crear overload ambiguo — como en la 019)
DROP FUNCTION IF EXISTS public.corregir_resultado(uuid, uuid, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.corregir_resultado(
  p_challenge_id uuid,
  p_editor_id    uuid,
  p_score_a      integer,
  p_score_b      integer,
  p_tiebreak_a   integer DEFAULT NULL,
  p_tiebreak_b   integer DEFAULT NULL,
  p_sets         jsonb   DEFAULT NULL
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
  v_formato    text;
  v_sets       jsonb;
  v_val        jsonb;
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

  -- Marcador: valida con validar_marcador según el formato vigente.
  SELECT COALESCE(formato_partido, 'set9') INTO v_formato FROM v2_config WHERE id = 1;
  IF p_sets IS NULL THEN
    v_sets := jsonb_build_array(jsonb_build_object('a', p_score_a, 'b', p_score_b));
  ELSE
    v_sets := p_sets;
  END IF;
  v_val := validar_marcador(v_formato, v_sets);
  IF NOT (v_val->>'ok')::boolean THEN
    RAISE EXCEPTION '%', v_val->>'error';
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
  SET score_a = (v_val->>'score_a')::int,
      score_b = (v_val->>'score_b')::int,
      sets = v_sets,
      tiebreak_a = p_tiebreak_a,
      tiebreak_b = p_tiebreak_b,
      ganador = CASE WHEN v_val->>'ganador' = 'a' THEN 'challenger' ELSE 'challenged' END,
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
$function$;

-- ── foto_jueves: notas de partidos con detalle de sets si existe ─────
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'nombre', nombre, 'apellido', apellido,
           'posicion', posicion, 'victorias', victorias, 'derrotas', derrotas
         ) ORDER BY posicion), '[]'::jsonb)
    INTO v_data
    FROM players WHERE activo AND posicion IS NOT NULL;

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

  -- notas: partidos de los últimos 7 días (detalle de sets si existe)
  SELECT array_agg(
           ch.nombre || ' ' || ch.apellido || ' ' ||
           COALESCE(
             (SELECT string_agg((s->>'a') || '-' || (s->>'b'), ' ')
                FROM jsonb_array_elements(c.sets) s),
             c.score_a || '-' || c.score_b
           )
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

  SELECT array_agg(nombre || ' ' || apellido || ' está lesionado' ORDER BY posicion)
    INTO v_les
    FROM players WHERE activo AND lesionado;

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

  INSERT INTO ranking_history (semana, fecha, data, movimientos, publicado_por, hora_publicacion)
  VALUES (v_nueva_sem, v_today, v_data, v_mov, 'auto', now())
  ON CONFLICT (semana) DO UPDATE
    SET fecha            = EXCLUDED.fecha,
        data             = EXCLUDED.data,
        movimientos      = EXCLUDED.movimientos,
        publicado_por    = EXCLUDED.publicado_por,
        hora_publicacion = EXCLUDED.hora_publicacion;

  UPDATE players SET posicion_anterior = posicion
   WHERE activo AND posicion IS NOT NULL;

  UPDATE weekly_config
     SET semana           = v_nueva_sem,
         fecha_inicio     = v_today,
         fecha_cierre     = v_today + 7,
         fecha_ranking    = v_today + 7,
         publicado_manual = false
   WHERE id = 1;

  UPDATE v2_config SET last_foto_jueves_date = v_today WHERE id = 1;

  RETURN jsonb_build_object(
    'ok', true, 'fecha', v_today, 'semana', v_nueva_sem,
    'jugadores', jsonb_array_length(v_data),
    'movimientos', jsonb_array_length(v_moves),
    'notas', jsonb_array_length(v_notas)
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'foto_jueves falló: %', SQLERRM;
END;
$function$;


-- ============ MIGRACIÓN 022: perdonar_inactividad ============

-- V2 — Migración 022: admin_perdonar_inactividad
-- El admin resetea el reloj de inactividad de un jugador (dias/semanas a 0).
-- NO toca lesionado ni posición (para devolver puestos está admin_ajustar_posicion).
-- Deja fila en ranking_log causa 'admin' con el motivo (desde=hasta=posición actual).

CREATE OR REPLACE FUNCTION public.admin_perdonar_inactividad(p_player uuid, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pos    integer;
  v_activo boolean;
  v_dias   integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'Debes indicar un motivo';
  END IF;

  SELECT posicion, activo, dias_inactivo INTO v_pos, v_activo, v_dias
    FROM players WHERE id = p_player;
  IF NOT FOUND OR NOT v_activo THEN
    RAISE EXCEPTION 'El jugador no está activo en el ranking';
  END IF;

  UPDATE players SET dias_inactivo = 0, semanas_inactivo = 0 WHERE id = p_player;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo, v_pos, v_pos);

  RETURN jsonb_build_object('ok', true, 'dias_perdonados', v_dias);

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'admin_perdonar_inactividad falló: %', SQLERRM;
END;
$function$;


-- ============ MIGRACIÓN 023: reloj_admin_lifecycle ============

-- V2 — Migración 023: control admin del reloj de inactividad + lifecycle
-- =====================================================================
-- - players.inactividad_congelada: pausa indefinida del reloj (el congelado
--   NO incrementa en cron_diario, pero SIGUE siendo desafiable). Jugar descongela.
-- - RPCs admin: congelar / descongelar / ajustar reloj / activar / inactivar.
--   Todas SECURITY DEFINER + advisory lock + ranking_log causa 'admin'.
-- =====================================================================

ALTER TABLE players ADD COLUMN IF NOT EXISTS inactividad_congelada boolean NOT NULL DEFAULT false;

-- ── aplicar_resultado: jugar (o WO) también descongela el reloj ──────
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Desafío no encontrado: %', p_challenge_id; END IF;
  IF c.ranking_applied THEN RETURN jsonb_build_object('ok', false, 'motivo', 'ya_aplicado'); END IF;
  IF c.status <> 'completed' OR c.ganador IS NULL THEN
    RAISE EXCEPTION 'El desafío no tiene resultado completo (status=%, ganador=%)', c.status, c.ganador;
  END IF;

  IF c.ganador = 'challenger' THEN
    win_id := c.challenger_id;  lose_id := c.challenged_id;
  ELSIF c.ganador = 'challenged' THEN
    win_id := c.challenged_id;  lose_id := c.challenger_id;
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
    UPDATE players SET posicion = posicion + 1
     WHERE activo = true AND posicion >= pos_lose AND posicion < pos_win;
    UPDATE players SET posicion = pos_lose WHERE id = win_id;
    movio := true;
  END IF;

  PERFORM recalcular_stats(win_id, lose_id);

  UPDATE players
  SET ultima_fecha_jugada  = now(),
      semanas_inactivo     = 0,
      dias_inactivo        = 0,
      inactividad_congelada = false,   -- jugar descongela
      lesionado            = false,
      lesion_nota          = '',
      lesion_fecha         = NULL
  WHERE id IN (win_id, lose_id);

  UPDATE challenges
  SET ranking_applied = true, snapshot_pre = snap, applied_at = now()
  WHERE id = p_challenge_id;

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
    'ok', true, 'movio_ranking', movio, 'ganador_id', win_id, 'perdedor_id', lose_id,
    'posicion_ganador_antes', pos_win,
    'posicion_ganador_ahora', CASE WHEN movio THEN pos_lose ELSE pos_win END
  );
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'aplicar_resultado falló: %', SQLERRM;
END;
$function$;

-- ── cron_diario: los congelados no incrementan (pausados) ────────────
CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last_date date; v_dias_exp integer;
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0;
  arr_id uuid[]; n integer; k integer; idx integer; step integer; rec RECORD;
  movio boolean := false; moved jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := (now() AT TIME ZONE 'UTC')::date;
  SELECT last_cron_daily_date, COALESCE(dias_expiracion_desafio, 7)
    INTO v_last_date, v_dias_exp FROM v2_config WHERE id = 1;
  IF v_last_date = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

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

  -- 3) INCREMENTO: +1 a activos sin pausa, sin resultado hoy, no debutantes
  --    y NO congelados (inactividad_congelada pausa el reloj indefinidamente).
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

-- ── foto_jueves: notas de inactivos con sufijo congelado + lista aparte ──
CREATE OR REPLACE FUNCTION public.foto_jueves()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last date; v_sem integer; v_nueva_sem integer;
  v_data jsonb; v_moves jsonb; v_notas jsonb; v_mov jsonb;
  v_partidos text[]; v_les text[]; v_inact text[]; v_congel text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := current_date;
  SELECT last_foto_jueves_date INTO v_last FROM v2_config WHERE id = 1;
  IF v_last = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

  SELECT semana INTO v_sem FROM weekly_config WHERE id = 1;
  v_nueva_sem := COALESCE(v_sem, 0) + 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', id, 'nombre', nombre, 'apellido', apellido,
           'posicion', posicion, 'victorias', victorias, 'derrotas', derrotas) ORDER BY posicion), '[]'::jsonb)
    INTO v_data FROM players WHERE activo AND posicion IS NOT NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'nombre', nombre || ' ' || apellido, 'desde', posicion_anterior, 'hasta', posicion,
           'delta', posicion_anterior - posicion, 'motivo', 'movimiento de la semana') ORDER BY posicion), '[]'::jsonb)
    INTO v_moves FROM players
   WHERE activo AND posicion IS NOT NULL AND posicion_anterior IS NOT NULL AND posicion_anterior <> posicion;

  SELECT array_agg(
           ch.nombre || ' ' || ch.apellido || ' ' ||
           COALESCE((SELECT string_agg((s->>'a') || '-' || (s->>'b'), ' ') FROM jsonb_array_elements(c.sets) s),
                    c.score_a || '-' || c.score_b)
           || CASE WHEN c.is_wo THEN ' WO' ELSE '' END || ' ' || cd.nombre || ' ' || cd.apellido
           ORDER BY c.applied_at)
    INTO v_partidos
    FROM challenges c JOIN players ch ON ch.id = c.challenger_id JOIN players cd ON cd.id = c.challenged_id
   WHERE c.status = 'completed' AND c.applied_at IS NOT NULL AND c.applied_at >= now() - interval '7 days';

  SELECT array_agg(nombre || ' ' || apellido || ' está lesionado' ORDER BY posicion)
    INTO v_les FROM players WHERE activo AND lesionado;

  SELECT array_agg(
           nombre || ' ' || apellido || ' lleva ' || semanas_inactivo || ' semanas (' || dias_inactivo || ' días) sin jugar'
           || CASE WHEN inactividad_congelada THEN ' (reloj congelado)' ELSE '' END
           ORDER BY dias_inactivo DESC)
    INTO v_inact FROM players WHERE activo AND dias_inactivo >= 7;

  -- Congelados aparte, aunque tengan pocos días (la visibilidad evita olvidos)
  SELECT array_agg(nombre || ' ' || apellido || ' tiene el reloj congelado (' || dias_inactivo || ' días en pausa)' ORDER BY nombre)
    INTO v_congel FROM players WHERE activo AND inactividad_congelada;

  v_notas := to_jsonb(
    COALESCE(v_partidos, '{}'::text[]) || COALESCE(v_les, '{}'::text[])
    || COALESCE(v_inact, '{}'::text[]) || COALESCE(v_congel, '{}'::text[]));

  v_mov := jsonb_build_object('movements', v_moves, 'notas', v_notas, 'penaltyLog', '[]'::jsonb);

  INSERT INTO ranking_history (semana, fecha, data, movimientos, publicado_por, hora_publicacion)
  VALUES (v_nueva_sem, v_today, v_data, v_mov, 'auto', now())
  ON CONFLICT (semana) DO UPDATE
    SET fecha = EXCLUDED.fecha, data = EXCLUDED.data, movimientos = EXCLUDED.movimientos,
        publicado_por = EXCLUDED.publicado_por, hora_publicacion = EXCLUDED.hora_publicacion;

  UPDATE players SET posicion_anterior = posicion WHERE activo AND posicion IS NOT NULL;
  UPDATE weekly_config SET semana = v_nueva_sem, fecha_inicio = v_today,
         fecha_cierre = v_today + 7, fecha_ranking = v_today + 7, publicado_manual = false WHERE id = 1;
  UPDATE v2_config SET last_foto_jueves_date = v_today WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'fecha', v_today, 'semana', v_nueva_sem,
    'jugadores', jsonb_array_length(v_data), 'movimientos', jsonb_array_length(v_moves),
    'notas', jsonb_array_length(v_notas));
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'foto_jueves falló: %', SQLERRM;
END;
$function$;

-- ── Congelar / descongelar reloj ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_congelar_inactividad(p_player uuid, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pos integer; v_activo boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'Debes indicar un motivo'; END IF;
  SELECT posicion, activo INTO v_pos, v_activo FROM players WHERE id = p_player;
  IF NOT FOUND OR NOT v_activo THEN RAISE EXCEPTION 'El jugador no está activo en el ranking'; END IF;
  UPDATE players SET inactividad_congelada = true WHERE id = p_player;
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo || ' — reloj congelado', v_pos, v_pos);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'admin_congelar_inactividad falló: %', SQLERRM;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_descongelar_inactividad(p_player uuid, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pos integer; v_activo boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'Debes indicar un motivo'; END IF;
  SELECT posicion, activo INTO v_pos, v_activo FROM players WHERE id = p_player;
  IF NOT FOUND OR NOT v_activo THEN RAISE EXCEPTION 'El jugador no está activo en el ranking'; END IF;
  UPDATE players SET inactividad_congelada = false WHERE id = p_player;
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo || ' — reloj descongelado', v_pos, v_pos);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'admin_descongelar_inactividad falló: %', SQLERRM;
END;
$function$;

-- ── Ajustar reloj (fijar días; NO penaliza — eso lo hace el cron al cruzar) ──
CREATE OR REPLACE FUNCTION public.admin_ajustar_reloj(p_player uuid, p_dias integer, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pos integer; v_activo boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'Debes indicar un motivo'; END IF;
  IF p_dias IS NULL OR p_dias < 0 THEN RAISE EXCEPTION 'Los días deben ser un entero ≥ 0'; END IF;
  SELECT posicion, activo INTO v_pos, v_activo FROM players WHERE id = p_player;
  IF NOT FOUND OR NOT v_activo THEN RAISE EXCEPTION 'El jugador no está activo en el ranking'; END IF;
  UPDATE players SET dias_inactivo = p_dias, semanas_inactivo = floor(p_dias / 7.0)::int WHERE id = p_player;
  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo || ' — reloj ajustado a ' || p_dias || ' días', v_pos, v_pos);
  RETURN jsonb_build_object('ok', true, 'dias', p_dias);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'admin_ajustar_reloj falló: %', SQLERRM;
END;
$function$;

-- ── Activar jugador (inserta desplazando) ───────────────────────────
CREATE OR REPLACE FUNCTION public.admin_activar_jugador(p_player uuid, p_posicion integer, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_n integer; v_activo boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'Debes indicar un motivo'; END IF;
  SELECT activo INTO v_activo FROM players WHERE id = p_player;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jugador no encontrado'; END IF;
  IF v_activo THEN RAISE EXCEPTION 'El jugador ya está activo'; END IF;

  SELECT count(*) INTO v_n FROM players WHERE activo AND posicion IS NOT NULL;
  IF p_posicion IS NULL OR p_posicion < 1 OR p_posicion > v_n + 1 THEN
    RAISE EXCEPTION 'Posición fuera de rango (1..%)', v_n + 1;
  END IF;

  UPDATE players SET posicion = posicion + 1
   WHERE activo AND posicion IS NOT NULL AND posicion >= p_posicion;

  UPDATE players
     SET activo = true, posicion = p_posicion,
         dias_inactivo = 0, semanas_inactivo = 0, inactividad_congelada = false
   WHERE id = p_player;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo || ' — activado', NULL, p_posicion);
  RETURN jsonb_build_object('ok', true, 'posicion', p_posicion);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'admin_activar_jugador falló: %', SQLERRM;
END;
$function$;

-- ── Inactivar jugador (compacta el ranking) ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_inactivar_jugador(p_player uuid, p_motivo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pos integer; v_activo boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));
  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'Debes indicar un motivo'; END IF;
  SELECT posicion, activo INTO v_pos, v_activo FROM players WHERE id = p_player;
  IF NOT FOUND OR NOT v_activo OR v_pos IS NULL THEN RAISE EXCEPTION 'El jugador no está activo en el ranking'; END IF;

  UPDATE players SET activo = false, posicion = NULL WHERE id = p_player;
  UPDATE players SET posicion = posicion - 1 WHERE activo AND posicion IS NOT NULL AND posicion > v_pos;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (p_player, 'admin', p_motivo || ' — inactivado', v_pos, NULL);
  RETURN jsonb_build_object('ok', true, 'desde', v_pos);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'admin_inactivar_jugador falló: %', SQLERRM;
END;
$function$;


-- ============ MIGRACIÓN 024: corregir_mensaje ============

-- V2 — Migración 024: corregir_resultado, SOLO el texto del guard de "último aplicado"
-- =====================================================================
-- Cambio mínimo de UX: el guard que exige que el partido a corregir sea el
-- ÚLTIMO aplicado sigue IGUAL (bloquea a jugadores Y admin), pero su mensaje
-- ya no sugiere una salida de admin inexistente en esta función. Para reparar
-- un partido más antiguo, el admin usa "Ajustar posición".
-- Se reproduce la función completa vigente (misma firma con p_sets, sin overload)
-- con únicamente ese string modificado.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.corregir_resultado(
  p_challenge_id uuid,
  p_editor_id    uuid,
  p_score_a      integer,
  p_score_b      integer,
  p_tiebreak_a   integer DEFAULT NULL,
  p_tiebreak_b   integer DEFAULT NULL,
  p_sets         jsonb   DEFAULT NULL
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
  v_formato    text;
  v_sets       jsonb;
  v_val        jsonb;
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
    RAISE EXCEPTION 'Este partido ya no es el último aplicado: no se puede corregir (usa Ajustar posición para reparar el ranking si hace falta)';
  END IF;

  -- Marcador: valida con validar_marcador según el formato vigente.
  SELECT COALESCE(formato_partido, 'set9') INTO v_formato FROM v2_config WHERE id = 1;
  IF p_sets IS NULL THEN
    v_sets := jsonb_build_array(jsonb_build_object('a', p_score_a, 'b', p_score_b));
  ELSE
    v_sets := p_sets;
  END IF;
  v_val := validar_marcador(v_formato, v_sets);
  IF NOT (v_val->>'ok')::boolean THEN
    RAISE EXCEPTION '%', v_val->>'error';
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
  SET score_a = (v_val->>'score_a')::int,
      score_b = (v_val->>'score_b')::int,
      sets = v_sets,
      tiebreak_a = p_tiebreak_a,
      tiebreak_b = p_tiebreak_b,
      ganador = CASE WHEN v_val->>'ganador' = 'a' THEN 'challenger' ELSE 'challenged' END,
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
$function$;

-- 2) Base de prueba: restaurar ventana de validación a 1440 min (estaba en 60)
UPDATE v2_config SET ventana_validacion_minutos = 1440 WHERE id = 1;


