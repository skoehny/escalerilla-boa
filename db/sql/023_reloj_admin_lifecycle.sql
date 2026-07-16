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
