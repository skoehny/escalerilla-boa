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
