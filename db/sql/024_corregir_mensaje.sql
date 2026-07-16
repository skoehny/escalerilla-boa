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
