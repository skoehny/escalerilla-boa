-- V2 — Migración 028: los lesionados no consumen cupo del rango de desafío
-- =====================================================================
-- CONTEXTO
--   Hasta la 016 el rango de desafío era aritmética posicional pura:
--     cd.posicion >= ch.posicion - max_puestos_desafio
--   Un lesionado dentro de ese tramo bloqueaba su puesto sin liberar nada: no era
--   desafiable (guarda cd.lesionado) y tampoco corría la ventana hacia arriba. En
--   la práctica el rango se encogía. Caso real de la base: el #22 tenía a #21, #20,
--   #19 y #18 lesionados => CERO desafíos posibles sin Wild Card.
--
-- REGLA NUEVA
--   Elegibles = los N rivales NO lesionados más cercanos hacia arriba, con
--   N = v2_config.max_puestos_desafio (sigue configurable desde el panel admin).
--   - Los lesionados solo se SALTAN (no ocupan cupo).
--   - Los jugadores con desafío activo SÍ siguen ocupando cupo: no se filtran aquí;
--     los rechaza la guarda de "1 desafío activo por jugador" que va más arriba.
--   - Cerca del tope: si hay menos de N sanos por encima, todos ellos son elegibles.
--   - Wild Card: sin cambio (exenta del rango; el lesionado sigue no desafiable,
--     porque la guarda cd.lesionado está FUERA del IF p_is_wildcard).
--
-- ALCANCE
--   CREATE OR REPLACE de crear_desafio() y NADA MÁS. Todo lo demás queda idéntico a
--   la 016: firma, SECURITY DEFINER, search_path, advisory lock, guardas de activo/
--   posición, 1 desafío activo por lado, lesionado no desafiable, wildcard_usada,
--   reactivación del challenger lesionado (+ ranking_log 'reactivacion'), deadline.
--   NO toca el reloj de inactividad (dias_inactivo, dias_ajuste_saneo, cron_diario,
--   congelamiento, aplazamiento), ni aplicar_resultado, ni foto_jueves, ni los crons.
--   NO cambia el valor de max_puestos_desafio ni el panel admin.
-- =====================================================================

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

  -- Rango (salvo WildCard): los N NO lesionados más cercanos hacia arriba.
  -- Los lesionados se saltan (no ocupan cupo). Los que tienen desafío activo SÍ
  -- ocupan cupo: entran en esta lista y los rechaza la guarda de más arriba.
  IF p_is_wildcard THEN
    IF ch.wildcard_usada THEN
      RAISE EXCEPTION 'Ya usaste tu WildCard';
    END IF;
  ELSE
    SELECT COALESCE(max_puestos_desafio, 4) INTO v_max FROM v2_config WHERE id = 1;
    IF NOT EXISTS (
      SELECT 1
        FROM (SELECT p.id
                FROM players p
               WHERE p.activo
                 AND p.posicion IS NOT NULL
                 AND p.posicion < ch.posicion
                 AND NOT COALESCE(p.lesionado, false)
               ORDER BY p.posicion DESC
               LIMIT v_max) elegibles
       WHERE elegibles.id = p_challenged
    ) THEN
      RAISE EXCEPTION 'Solo puedes desafiar a los % rivales disponibles más cercanos hacia arriba (los lesionados no ocupan cupo)', v_max;
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
