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
