-- V2 — Migración 032: el reloj se congela para quien no tiene a quién desafiar
-- =====================================================================
-- QUÉ GENERALIZA
--   La mig 031 congela el reloj del #1 sano porque no puede desafiar a nadie: su
--   inactividad no depende de él. Pero el mismo problema aparece un puesto más
--   abajo apenas el #1 se lesiona: el #2 queda sin rivales —su único rival hacia
--   arriba es el #1, que es indesafiable por lesionado— y sin embargo su reloj
--   corría y podía penalizarlo a los 14 días. Y en cascada: con el #1 y el #2
--   lesionados le pasa al #3, y así.
--
-- REGLA (mig 032)
--   Se congela el reloj —conserva su valor, no avanza— de todo jugador SANO que no
--   tenga ningún rival desafiable por encima, es decir cuando todos los jugadores
--   con posición menor están lesionados, o no existe ninguno.
--   El #1 sano de la 031 pasa a ser el caso particular "cero jugadores arriba".
--   Los LESIONADOS nunca se congelan por esta vía: su reloj siempre corre, porque
--   es exactamente lo que destraba los bloqueos (igual que en la 031 — un #1
--   lesionado es indesafiable y solo su reloj libera la punta).
--
--   Congelar sigue siendo CONSERVAR, no borrar: lo único que reinicia un reloj a 0
--   es jugar (aplicar_resultado). El contador es monótono mientras no se juegue.
--
-- ALCANCE DE "SIN RIVALES DESAFIABLES" — DECISIONES TOMADAS
--
--   (a) Significa "todos los de arriba están lesionados (o no hay nadie arriba)".
--       NO incluye "rivales sanos pero ocupados con un desafío activo". Esa
--       situación es transitoria —los desafíos expiran en ~7 días o se juegan—,
--       rara vez alcanza por sí sola para cruzar un umbral, y congelarla
--       incentivaría esperar a que los rivales se ocupen para congelarse gratis.
--       Exclusión deliberada.
--
--   (b) La Wild Card se ignora. Un jugador con Wild Card disponible podría
--       técnicamente desafiar fuera de rango, pero no se le va a exigir quemar su
--       única Wild Card del año para evitar que se le congele el reloj (que además
--       lo beneficia). La condición mira solo la elegibilidad normal.
--
--   (c) "Todos los de arriba lesionados" ⇒ "cero rivales por la vía normal".
--       Se apoya en la regla de la mig 028 (crear_desafio): los elegibles son los N
--       rivales NO LESIONADOS más cercanos hacia arriba —los lesionados se saltan
--       sin ocupar cupo—, así que basta UN sano en cualquier posición por encima,
--       por lejos que esté, para tener rival. La recíproca es la que usamos acá:
--       sin ningún sano arriba, el conjunto de elegibles es vacío. Además
--       crear_desafio exige cd.posicion < ch.posicion y rechaza al desafiado
--       lesionado, así que no hay otra vía normal de escape.
--
--   (d) Freeze global (mig 025/026): si hay un freeze vigente, el cron no
--       incrementa a NADIE —tampoco a los lesionados que destraban bloqueos— porque
--       la rama congelada retorna antes de llegar acá. Es la semántica existente y
--       es la correcta: el freeze es una decisión explícita del admin que pausa
--       todo parejo. Esta migración no la altera.
--
-- CÓMO QUEDA IMPLEMENTADO
--   ÚNICAMENTE por la exclusión de _incr, igual que la 031: congelar es, literal,
--   no hacer nada. Sin normalizaciones, sin sentencia one-shot, sin cambios de
--   datos. _pen y la auto-lesión siguen SIN filtros propios: ambos dependen de la
--   pertenencia a _incr, y esa es la invariante que sostiene toda la regla — quien
--   está congelado no avanza, y por lo tanto no puede cruzar un umbral.
--
--   La condición se evalúa dentro del CREATE TEMP TABLE _incr, o sea con el estado
--   de ENTRADA de la corrida (antes del incremento y del reacomodo), coherente con
--   el resto del cron.
--
--   Costo: una subconsulta correlacionada por jugador activo. Con ~30 jugadores son
--   ~30 EXISTS sobre una tabla de 30 filas, resueltos en memoria — irrelevante
--   frente al resto de la función (que ya recorre el ranking en un bucle PL/pgSQL).
--   Si algún día el club creciera un orden de magnitud, la reescritura natural es
--   un min(posicion) FILTER (WHERE NOT lesionado) calculado una sola vez.
--
--   posicion NULL: un activo sin posición sigue entrando a _incr como siempre. Hay
--   que decirlo explícitamente porque `q.posicion < NULL` es NULL y el EXISTS daría
--   falso, que lo habría excluido por accidente.
--
-- OBSERVABILIDAD
--   El retorno cambia 'lider_congelado' por 'congelados_sin_rivales': cuántos
--   jugadores activos y sanos no tenían rival desafiable arriba en esa corrida
--   (el #1 sano incluido). NO se escribe una línea de ranking_log por corrida:
--   congelar es un no-evento diario y spamearía el log. La señal es el contador.
--
-- CASOS BORDE (razonados y verificados en test_032_reloj_sin_rivales.mjs)
--   • El congelado desafiado desde abajo que pierde: baja jugando, y
--     aplicar_resultado le deja el reloj en 0. Nada especial.
--   • El #2 congelado cuyo #1 se recupera o baja: vuelve a tener rival y acumula
--     desde el valor que conservaba, sin saltos ni reposiciones.
--   • El #1 lesionado que alterna lesión/alta: sobre el #2 el efecto es benigno —
--     su contador solo alterna pausa y avance, nunca salta ni se borra. Y sobre sí
--     mismo el ciclo sigue siendo inútil (mig 031: contador monótono).
--   • Todos lesionados menos uno: ese único sano queda congelado. Correcto — no
--     tiene a quién desafiar.
--
--   • ⚠ EL CONGELADO COMO PISO DEL REACOMODO. En la 031 el congelado era siempre
--     el #1 = arr_id[1], y el barrier solo se consulta sobre arr_id[idx + 1] (el de
--     abajo), así que su presencia en _barrier era inerte. Acá ya no: un congelado
--     puede estar en cualquier posición y quedar justo debajo de un lesionado que
--     está bajando. Si ese congelado trae un reloj >= 14 entra en _barrier y FRENA
--     la bajada — igual que cualquier otro inactivo, es el floor de siempre
--     ("nadie cae por debajo de otro que también esté inactivo").
--     La diferencia es la duración: el reloj del congelado ya no sube ni baja solo,
--     así que el bloqueo dura hasta que el congelado JUEGUE o hasta que alguien de
--     arriba se recupere.
--
--     DECISIÓN: se deja como está. No se toca ni el barrier ni el floor. Razones:
--       1. El escenario es estrecho: exige un lesionado arriba Y un congelado con
--          reloj >= 14 justo abajo. Y ese reloj alto solo pudo acumularse mientras
--          el jugador SÍ tenía rivales disponibles — o sea, no se lo ganó estando
--          congelado; son días de inactividad que le corresponden.
--       2. El bloqueo tiene salida natural: el congelado está sano y por lo tanto
--          es desafiable desde abajo. En cuanto juega, su reloj se va a 0, sale del
--          barrier y el de arriba baja en la corrida siguiente. Verificado en el
--          escenario (c) de db/cutover/test_032_reloj_sin_rivales.mjs, que prueba
--          las dos mitades: bloqueado primero, desbloqueado después de jugar.
--       3. Modificar el barrier alteraría el floor de TODO el ranking, que es una
--          regla publicada en el reglamento ("ningún jugador cae por debajo de otro
--          que también esté inactivo"). El costo de tocarla supera al del caso.
--     Si el caso aparece en la práctica, se reabre CON DATOS. La vía mínima queda
--     anotada: excluir de _barrier a los sanos sin rivales desafiables.
--
-- LO QUE NO TOCA
--   Pausa por desafío activo, freeze global (025/026) e individual (023),
--   expiración de desafíos, barrier/floor, idempotencia diaria, dias_ajuste_saneo
--   (027), aplicar_resultado, crear_desafio, foto_jueves.
--
-- ALCANCE: CREATE OR REPLACE de cron_diario() y NADA MÁS. Base: mig 031.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.cron_diario()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date; v_last_date date; v_dias_exp integer;
  v_congel_motivo text; n_aplaz integer := 0;
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0; n_sin_riv integer := 0;
  arr_id uuid[]; n integer; k integer; idx integer; step integer; rec RECORD;
  movio boolean := false; moved jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_resultado'));

  v_today := (now() AT TIME ZONE 'UTC')::date;
  SELECT last_cron_daily_date, COALESCE(dias_expiracion_desafio, 7)
    INTO v_last_date, v_dias_exp FROM v2_config WHERE id = 1;

  -- Guard de idempotencia diaria (aplica a AMBAS ramas: normal y congelada).
  IF v_last_date = v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'ya_corrio_hoy', 'fecha', v_today);
  END IF;

  -- ── RAMA CONGELADA (mig 026) ────────────────────────────────────────
  -- Única acción: aplazar +1 día el deadline de los desafíos vigentes.
  -- NO suma dias_inactivo, NO expira, NO penaliza, NO procesa WO.
  SELECT motivo INTO v_congel_motivo
    FROM reloj_freeze_log WHERE descongelado_en IS NULL LIMIT 1;
  IF v_congel_motivo IS NOT NULL THEN
    UPDATE challenges
       SET deadline = COALESCE(deadline, created_at::date + v_dias_exp) + 1
     WHERE status IN ('pending', 'accepted');
    GET DIAGNOSTICS n_aplaz = ROW_COUNT;

    INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta, challenge_id)
    SELECT challenger_id, 'admin', 'aplazamiento diario por congelamiento', NULL, NULL, id
      FROM challenges WHERE status IN ('pending', 'accepted');

    UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

    RETURN jsonb_build_object('ok', true, 'skipped', 'reloj_congelado',
      'motivo', v_congel_motivo, 'aplazados', n_aplaz, 'fecha', v_today);
  END IF;

  -- ── RAMA NORMAL ─────────────────────────────────────────────────────
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

  -- INCREMENTO: +1 a activos sin pausa, sin resultado hoy, no debutantes y no
  -- congelados individualmente... y que TENGAN a quién desafiar (mig 032).
  --
  -- El bloque de tres términos es la regla completa:
  --   1. lesionado           → siempre entra: su reloj es lo que destraba la punta.
  --   2. posicion IS NULL    → entra, como siempre (sin esta línea el EXISTS de
  --                            abajo daría NULL y lo excluiría por accidente).
  --   3. EXISTS un sano arriba → tiene rival desafiable, así que su inactividad
  --                            sí depende de él. Sin ninguno, se congela: no suma,
  --                            pero conserva el valor que traiga.
  -- Quedar fuera de _incr es TODA la implementación del congelamiento: no hay
  -- ningún UPDATE que toque el reloj de un congelado.
  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND ( COALESCE(p.lesionado, false)
             OR p.posicion IS NULL
             OR EXISTS (SELECT 1 FROM players q
                         WHERE q.activo AND q.posicion IS NOT NULL
                           AND q.posicion < p.posicion
                           AND NOT COALESCE(q.lesionado, false)) )
       AND NOT COALESCE(p.inactividad_congelada, false)
       AND p.id NOT IN (SELECT pid FROM _paused)
       AND (p.ultima_fecha_jugada IS NULL OR p.ultima_fecha_jugada::date < v_today)
       AND NOT (COALESCE(p.victorias,0) = 0 AND COALESCE(p.derrotas,0) = 0);

  -- Observabilidad: cuántos sanos no tenían rival desafiable arriba en esta
  -- corrida (el #1 sano incluido). Se evalúa con el estado de entrada. No se
  -- escribe en ranking_log: congelar es un no-evento diario y spamearía el log.
  SELECT count(*) INTO n_sin_riv
    FROM players p
   WHERE p.activo AND p.posicion IS NOT NULL
     AND NOT COALESCE(p.lesionado, false)
     AND NOT EXISTS (SELECT 1 FROM players q
                      WHERE q.activo AND q.posicion IS NOT NULL
                        AND q.posicion < p.posicion
                        AND NOT COALESCE(q.lesionado, false));

  UPDATE players SET dias_inactivo = dias_inactivo + 1 WHERE id IN (SELECT id FROM _incr);

  -- Recalcula semanas para TODOS los activos, no solo los de _incr: por eso los
  -- congelados se mantienen consistentes sin tratamiento especial.
  UPDATE players SET semanas_inactivo = floor(dias_inactivo / 7.0)::int
   WHERE activo AND semanas_inactivo IS DISTINCT FROM floor(dias_inactivo / 7.0)::int;

  -- Insignia automática a los 28 días. Sin exclusiones propias: un congelado no
  -- está en _incr (su reloj no avanza, no puede cruzar el umbral) y un lesionado
  -- ya tiene la insignia.
  UPDATE players
     SET lesionado = true, lesion_fecha = now(),
         lesion_nota = CASE WHEN COALESCE(lesion_nota,'') = '' THEN 'Inactividad (4 semanas)' ELSE lesion_nota END
   WHERE id IN (SELECT id FROM _incr) AND dias_inactivo = 28;
  GET DIAGNOSTICS n_les = ROW_COUNT;

  -- Penalizaciones. Sin exclusiones propias, por la misma razón: la pertenencia a
  -- _incr ya deja fuera a los congelados, y los lesionados DEBEN entrar.
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

  -- (El reacomodo puede cambiar quién está congelado: si el #1 lesionado baja, el
  --  que sube a la punta pasa a estarlo y el que bajó recupera rivales. No hay
  --  nada que recalcular acá — la condición se vuelve a evaluar en la corrida
  --  siguiente, y cada reloj conserva mientras tanto el valor que traía.)

  IF movio THEN UPDATE v2_config SET last_cron_movement_at = now() WHERE id = 1; END IF;
  UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'fecha', v_today, 'expirados', n_exp,
    'penalizados', n_pen, 'lesionados_nuevos', n_les, 'congelados_sin_rivales', n_sin_riv,
    'movio', movio, 'movimientos', moved);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cron_diario falló: %', SQLERRM;
END;
$function$;
