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
