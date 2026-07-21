-- V2 — Migración 027: separar el residuo del saneo de julio en su propia columna
-- =====================================================================
-- CONTEXTO
--   El popup ⓘ "Reloj de inactividad" muestra "Días pausados o congelados" como
--     (días calendario desde ultima_fecha_jugada) − dias_inactivo.
--   Ese número mezcla DOS cosas:
--     (a) pausas REALES del reloj (freeze global + desafíos activos), y
--     (b) un RESIDUO HISTÓRICO del saneo de julio 2026 (hallazgo3): al arrancar
--         la v2 se redondearon los dias_inactivo hacia abajo a múltiplos de 7,
--         así que calendario − dias_inactivo quedó inflado por ese redondeo.
--
-- OBJETIVO
--   Congelar el residuo (b) en players.dias_ajuste_saneo (one-shot), para que el
--   popup pueda mostrar SOLO las pausas reales de aquí en adelante. La columna es
--   PURAMENTE INFORMATIVA para el popup: NO la lee el cron, ni penalizaciones, ni
--   badges, ni ningún cálculo de ranking. Se reinicia a 0 cuando el jugador juega
--   (aplicar_resultado).
--
-- INVARIANTE DEL PROYECTO (respetada)
--   La única fuente de la inactividad sigue siendo el contador incremental
--   players.dias_inactivo. Esta columna NO participa en él.
--
-- BACKFILL (one-shot, idempotente el mismo día: recalcula, NO acumula)
--   dias_ajuste_saneo = GREATEST(0,
--       (CURRENT_DATE − ultima_fecha_jugada::date) − dias_inactivo − DIAS_FREEZE)
--   donde DIAS_FREEZE = días calendario COMPLETOS del freeze global VIGENTE
--   (reloj_freeze_log con descongelado_en IS NULL; 0 si no hay freeze activo).
--   Se calcula EN SQL (no hardcode) porque test y prod se aplican en fechas
--   distintas y pueden tener el freeze en estados distintos.
--   Exclusiones: debutantes (0 victorias y 0 derrotas) y ultima_fecha_jugada NULL
--   quedan en 0 (no tienen reloj).
--
-- RLS / GRANTS
--   players ya tiene SELECT a nivel de tabla para anon/authenticated (la app usa
--   PIN auth propio → rol anon; ver lección de v2_config). Una columna nueva queda
--   cubierta por ese GRANT de tabla: el front la lee con players.select('*') sin
--   permisos extra. La escritura sigue siendo solo vía RPCs SECURITY DEFINER.
-- =====================================================================

-- ── 1) Columna ────────────────────────────────────────────────────────
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS dias_ajuste_saneo integer NOT NULL DEFAULT 0;

-- ── 2) Backfill one-shot ──────────────────────────────────────────────
-- DIAS_FREEZE se lee del freeze global vigente con el MISMO criterio de días
-- calendario completos que usa descongelar_reloj_global (mig 025).
UPDATE public.players p
   SET dias_ajuste_saneo = GREATEST(0,
         (CURRENT_DATE - p.ultima_fecha_jugada::date)
         - p.dias_inactivo
         - COALESCE((
             SELECT GREATEST(0, CURRENT_DATE - f.congelado_desde::date)
               FROM reloj_freeze_log f
              WHERE f.descongelado_en IS NULL
              ORDER BY f.congelado_desde DESC
              LIMIT 1
           ), 0))
 WHERE p.ultima_fecha_jugada IS NOT NULL
   AND NOT (COALESCE(p.victorias, 0) = 0 AND COALESCE(p.derrotas, 0) = 0);

-- ── 3) Reset al jugar: aplicar_resultado también pone el ajuste en 0 ───
-- (idéntica a la vigente — mig 023 — salvo la línea dias_ajuste_saneo = 0.
--  marcar_wo y corregir_resultado llaman a aplicar_resultado → cubiertos aquí.)
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
      dias_ajuste_saneo    = 0,         -- jugar borra el residuo histórico del saneo
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

-- ── Nota sobre reactivar_jugador ──────────────────────────────────────
-- Existe una función legacy public.reactivar_jugador(uuid) que pone
-- ultima_fecha_jugada = NULL (reingreso como debutante). NO existe en prod y no
-- la invoca ningún código de la app (grep del repo = 0 referencias), así que esta
-- migración NO la toca. No hace falta resetear dias_ajuste_saneo ahí: con ufj NULL
-- el popup no muestra el ajuste, y el próximo partido lo pone en 0 vía
-- aplicar_resultado. Si algún día se recrea/usa, debe incluir dias_ajuste_saneo = 0.
