-- V2 — Migración 025: Congelamiento GLOBAL del reloj de inactividad
-- =====================================================================
-- A diferencia del congelamiento POR-JUGADOR (players.inactividad_congelada,
-- mig 023), este es un freeze GLOBAL: mientras haya un freeze vigente, el
-- proceso diario (cron_diario) NO hace NADA — no suma dias_inactivo, no
-- penaliza, no expira desafíos, no procesa WO.
--
-- INVARIANTE: la ÚNICA fuente de la inactividad es el contador incremental
-- players.dias_inactivo. Este freeze simplemente pausa ese contador (y todo
-- el resto del cron) globalmente. Los días congelados no cuentan para nada.
--
-- Al descongelar, se extiende la fecha límite (challenges.deadline) de TODOS
-- los desafíos pending/accepted sumando los días calendario completos que
-- duró el freeze, con auditoría en ranking_log.
--
-- MODELO:
--  reloj_freeze_log: un registro con descongelado_en NULL = freeze VIGENTE.
--  Índice único parcial garantiza como máximo UN freeze activo a la vez.
--
-- RLS/GRANTS: la app usa PIN auth propio → SIEMPRE rol `anon` (ver lección de
--  v2_config). Por eso damos SELECT y EXECUTE a anon,authenticated. La escritura
--  de la tabla es solo vía RPCs SECURITY DEFINER (corren como owner, saltan RLS).
-- =====================================================================

-- ── Tabla ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.reloj_freeze_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  congelado_desde     timestamptz NOT NULL,
  descongelado_en     timestamptz,                 -- NULL = freeze vigente
  motivo              text NOT NULL,
  congelado_por       text,
  descongelado_por    text,
  dias_congelados     integer,                     -- se calcula al descongelar
  desafios_extendidos integer,                     -- cuántos deadlines se extendieron
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Máximo UN freeze vigente: índice único parcial sobre las filas sin descongelar.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reloj_freeze_activo
  ON public.reloj_freeze_log ((descongelado_en IS NULL))
  WHERE descongelado_en IS NULL;

-- ── RLS + GRANTS ──────────────────────────────────────────────────────
ALTER TABLE public.reloj_freeze_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reloj_freeze_log_read ON public.reloj_freeze_log;
CREATE POLICY reloj_freeze_log_read ON public.reloj_freeze_log FOR SELECT USING (true);
GRANT SELECT ON public.reloj_freeze_log TO anon, authenticated;
-- (Sin policy de INSERT/UPDATE: solo escriben las RPCs SECURITY DEFINER.)

-- ── Helper: ¿hay un freeze global vigente? ────────────────────────────
CREATE OR REPLACE FUNCTION public.reloj_esta_congelado()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM reloj_freeze_log WHERE descongelado_en IS NULL);
$function$;
GRANT EXECUTE ON FUNCTION public.reloj_esta_congelado() TO anon, authenticated;

-- ── Congelar (global) ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.congelar_reloj_global(p_motivo text, p_admin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
    RAISE EXCEPTION 'Debes indicar un motivo para congelar el reloj';
  END IF;

  IF EXISTS (SELECT 1 FROM reloj_freeze_log WHERE descongelado_en IS NULL) THEN
    RAISE EXCEPTION 'El reloj de inactividad ya está congelado';
  END IF;

  INSERT INTO reloj_freeze_log (congelado_desde, motivo, congelado_por)
  VALUES (now(), btrim(p_motivo), NULLIF(btrim(COALESCE(p_admin, '')), ''))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'freeze_id', v_id, 'congelado_desde', now());
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'congelar_reloj_global falló: %', SQLERRM;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.congelar_reloj_global(text, text) TO anon, authenticated;

-- ── Descongelar (global) + extender deadlines ─────────────────────────
CREATE OR REPLACE FUNCTION public.descongelar_reloj_global(p_admin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id       uuid;
  v_desde    timestamptz;
  v_dias     integer;
  v_dias_exp integer;
  v_ext      integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  SELECT id, congelado_desde INTO v_id, v_desde
    FROM reloj_freeze_log
   WHERE descongelado_en IS NULL
   FOR UPDATE;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'El reloj de inactividad no está congelado';
  END IF;

  -- Días calendario COMPLETOS entre el inicio del freeze y ahora (mínimo 0).
  -- Congelar/descongelar el mismo día = 0 días → no extiende nada.
  v_dias := GREATEST(0, (date_trunc('day', now())::date - date_trunc('day', v_desde)::date));

  SELECT COALESCE(dias_expiracion_desafio, 7) INTO v_dias_exp FROM v2_config WHERE id = 1;

  IF v_dias > 0 THEN
    -- Extender la fecha límite de TODOS los desafíos vigentes.
    -- Si deadline es NULL (desafíos viejos), se materializa desde created_at.
    UPDATE challenges
       SET deadline = COALESCE(deadline, created_at::date + v_dias_exp) + v_dias
     WHERE status IN ('pending', 'accepted');
    GET DIAGNOSTICS v_ext = ROW_COUNT;

    -- Auditoría: una entrada por desafío extendido.
    INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta, challenge_id)
    SELECT challenger_id, 'admin',
           'extensión por congelamiento global (+' || v_dias || ' días)',
           NULL, NULL, id
      FROM challenges
     WHERE status IN ('pending', 'accepted');
  END IF;

  UPDATE reloj_freeze_log
     SET descongelado_en     = now(),
         descongelado_por     = NULLIF(btrim(COALESCE(p_admin, '')), ''),
         dias_congelados      = v_dias,
         desafios_extendidos  = v_ext
   WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'dias_congelados', v_dias, 'desafios_extendidos', v_ext);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'descongelar_reloj_global falló: %', SQLERRM;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.descongelar_reloj_global(text) TO anon, authenticated;

-- ── cron_diario: si hay freeze global vigente, NO hace NADA ───────────
-- (misma lógica que mig 023, con el guard de congelamiento global al inicio)
CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last_date date; v_dias_exp integer;
  v_congel_motivo text;
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0;
  arr_id uuid[]; n integer; k integer; idx integer; step integer; rec RECORD;
  movio boolean := false; moved jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  -- Guard de CONGELAMIENTO GLOBAL: si hay freeze vigente, salir sin tocar nada.
  -- No suma dias_inactivo, no penaliza, no expira desafíos, no procesa WO, y NO
  -- avanza last_cron_daily_date (así al descongelar el cron corre normal enseguida).
  SELECT motivo INTO v_congel_motivo
    FROM reloj_freeze_log WHERE descongelado_en IS NULL LIMIT 1;
  IF v_congel_motivo IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'reloj_congelado', 'motivo', v_congel_motivo);
  END IF;

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
