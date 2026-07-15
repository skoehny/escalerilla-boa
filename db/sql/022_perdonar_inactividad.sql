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
