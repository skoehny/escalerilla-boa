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
