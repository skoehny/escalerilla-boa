-- V2 — Migración 031: el reloj del #1 se congela si está sano y corre si se lesiona
-- =====================================================================
-- REGLA DEFINITIVA
--   • #1 SANO: el reloj se CONGELA en el valor que tenga. No avanza (queda fuera
--     del incremento) y por lo tanto no cruza umbrales: sin penalizaciones y sin
--     insignia automática a los 28 días. Pero tampoco se borra: lo que traía, lo
--     conserva. Solo JUGAR lo reinicia a 0 (aplicar_resultado).
--     Razón de la protección: no puede desafiar a nadie (solo ser desafiado, mig
--     016/028), así que su inactividad no depende de él y no puede castigarlo.
--   • #1 LESIONADO: el reloj SÍ avanza, desde donde estaba, con los umbrales
--     normales (14: −2 puestos, 21: −1, 28: −1, y −1 cada 7 días más).
--     Razón: un lesionado no puede ser desafiado (guarda cd.lesionado en
--     crear_desafio). Un #1 lesionado bloquea la punta: nadie puede desafiarlo y
--     nada lo mueve. El reloj corriendo garantiza que la punta se libera.
--   En una frase: el #1 está protegido mientras sea DESAFIABLE, y la protección
--   CONGELA el reloj, no lo borra.
--
-- POR QUÉ CONGELAR Y NO NORMALIZAR A 0 (exploit que cierra esta versión)
--   La versión anterior de esta migración ponía dias_inactivo = 0 en cada corrida
--   mientras el #1 estuviera sano. Eso abría un ciclo infinito:
--     el #1 se lesiona (indesafiable, el reloj corre) → llega al día 13 → se da de
--     alta un día (el cron lo normaliza a 0) → se lesiona de nuevo → el reloj parte
--     de 0 otra vez. Nunca cruzaba el 14, seguía indesafiable casi siempre y la
--     punta quedaba bloqueada para siempre.
--   Congelando en vez de borrar, el contador es MONÓTONO: la suma de días
--   lesionado nunca se pierde, así que el umbral 14 llega sí o sí. Cada vuelta del
--   ciclo le "regala" exactamente los días que pase sano (0 avance de reloj), pero
--   cada uno de esos días es un día en que ES DESAFIABLE. El intercambio es
--   honesto: para atrasar el umbral N días hay que estar disponible N días.
--
-- CÓMO QUEDA IMPLEMENTADA LA PAUSA
--   ÚNICAMENTE por la exclusión de _incr. No hay ningún UPDATE que toque el reloj
--   del #1: congelar es, literalmente, no hacer nada. Eso hace que la regla sea
--   imposible de romper por un orden de sentencias y que no haya que re-normalizar
--   después del reacomodo.
--
-- TRANSICIONES
--   llega al #1 ganando : aplicar_resultado ya lo dejó en 0 → se congela en 0. Es
--                         el caso común y se comporta igual que antes.
--   sano → lesionado    : entra a _incr y el reloj sigue desde su valor actual.
--   lesionado → alta    : se congela donde esté; no se borra nada ni queda una
--                         penalización pendiente.
--   pierde el #1        : régimen normal (y si fue jugando, el reloj ya está en 0).
--   admin lo baja de la #1 con reloj congelado alto: vuelve a acumular desde ahí y
--                         puede cruzar umbrales pronto — correcto, esos días de
--                         inactividad existieron.
--
-- #1 SANO CON RELOJ SUCIO
--   Si un admin le deja el reloj en 27 con admin_ajustar_reloj, el #1 sano queda
--   CONGELADO en 27: no se lesiona ni baja mientras siga sano en la punta (no está
--   en _incr, y _pen y la auto-lesión dependen de _incr). Si después se lesiona,
--   cruza el 28 en un día — y está bien: ese reloj representa inactividad real. Si
--   el admin quiere limpiarlo de verdad, la herramienta es
--   admin_perdonar_inactividad (mig 022), que es explícita y deja log.
--
-- LA AUTO-LESIÓN NUNCA ALCANZA AL #1 SANO (por construcción, no por un filtro)
--   Tanto _pen como el UPDATE de la insignia están condicionados a pertenecer a
--   _incr, y el #1 sano nunca entra en _incr. Por eso este cron NO lleva ninguna
--   exclusión especial del #1 en esos dos bloques: sería redundante y escondería
--   la verdadera invariante.
--   Para un #1 YA lesionado que cruza los 28 días, el UPDATE solo estampa la nota
--   'Inactividad (4 semanas)' si venía vacía y refresca lesion_fecha — no es una
--   lesión nueva ni bloquea nada que la lesión manual no bloqueara ya.
--
-- semanas_inactivo DEL #1 CONGELADO
--   Queda consistente sin trabajo extra: el UPDATE global de semanas recalcula
--   floor(dias_inactivo / 7.0) para TODOS los activos, no solo para los de _incr.
--   Como el dias_inactivo del #1 sano no cambia, ese UPDATE simplemente no lo toca.
--
-- REACTIVACIÓN DEL #1 LESIONADO
--   La vía normal de volver de una lesión —crear un desafío, que reactiva al
--   challenger (mig 016/028)— NO está disponible para el #1: no tiene a quién
--   desafiar (el desafiado debe tener menor posición). Su única vía es el ALTA
--   desde su propio perfil (src/pages/Perfil.jsx: update de lesionado=false y
--   lesion_nota=''), o que un admin se la quite desde el panel.
--
-- VISIBILIDAD (decisiones tomadas, no son efectos colaterales)
--   Un #1 sano puede tener ahora un reloj congelado >= 7, así que:
--     • Ranking.jsx le mostrará el badge de inactividad "(2S 3D)". SE ACEPTA: es
--       información verdadera y útil — dice cuánto lleva sin jugar el líder, y no
--       impide desafiarlo (canChallenge solo mira lesionado / desafío activo).
--     • foto_jueves lo listará en las notas de inactivos (>= 7 días). SE ACEPTA:
--       misma razón; la nota es descriptiva, no una sanción.
--
-- ANTI-ABUSO ADICIONAL — PENDIENTE, NO IMPLEMENTADO
--   Sería útil que cada transición lesión/alta del #1 quedara en ranking_log para
--   que el admin detecte ciclos. NO se implementa acá porque hoy esas transiciones
--   son un UPDATE directo del cliente sobre players (Perfil.jsx / Admin.jsx), no
--   una RPC: registrarlas exigiría crear una RPC SECURITY DEFINER o abrir un INSERT
--   de cliente sobre una tabla de auditoría (falsificable). Con el reloj monótono
--   el exploit ya no rinde, así que no se agregan cooldowns ni límites de lesiones.
--
-- CASO BORDE DEL REACOMODO (comportamiento estándar, documentado)
--   El #1 lesionado penalizado baja y el #2 sube a la punta. El barrier/floor
--   aplica igual que para todos: solo frena la bajada si el jugador de abajo está
--   inactivo 14+ o es debutante. Si el #2 está sano y activo, la bajada ocurre y la
--   punta queda liberada; si el #2 también está inactivo 14+, el floor la frena y
--   la punta sigue bloqueada un ciclo más — aceptable, es el mismo floor que
--   protege a todo el ranking. El nuevo #1 conserva su reloj y queda congelado
--   desde la corrida siguiente, sin necesidad de re-normalizar nada.
--   El #1 sano también puede entrar en _barrier (reloj congelado >= 14): es inerte,
--   porque arr_id está ordenado por posición, el líder es arr_id[1] y el barrier
--   solo se consulta sobre arr_id[idx + 1] (el de abajo).
--
-- LO QUE NO TOCA
--   Pausa por desafío activo, congelamiento global (mig 025/026) e individual
--   (mig 023), expiración de desafíos, barrier/floor, idempotencia diaria,
--   dias_ajuste_saneo (mig 027), aplicar_resultado, crear_desafio, foto_jueves.
--
-- ALCANCE: CREATE OR REPLACE de cron_diario() y NADA MÁS. Sin cambios de datos:
--   congelar no requiere tocar ninguna fila, así que esta migración no lleva
--   sentencia one-shot.
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
  n_exp integer := 0; n_pen integer := 0; n_les integer := 0; n_lider integer := 0;
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

  -- INCREMENTO: +1 a activos sin pausa, sin resultado hoy, no debutantes, no
  -- congelados y que NO sean el #1 SANO (mig 031: su inactividad no depende de él).
  -- Quedar fuera de _incr es TODA la implementación del congelamiento del líder: no
  -- suma, pero conserva el valor que traiga. El #1 LESIONADO sí entra — es
  -- indesafiable y su reloj es lo único que libera la punta.
  -- La condición usa IS DISTINCT FROM para que un activo con posicion NULL siga
  -- entrando, igual que antes de esta migración.
  DROP TABLE IF EXISTS _incr;
  CREATE TEMP TABLE _incr ON COMMIT DROP AS
    SELECT p.id
      FROM players p
     WHERE p.activo
       AND ( p.posicion IS DISTINCT FROM 1 OR COALESCE(p.lesionado, false) )
       AND NOT COALESCE(p.inactividad_congelada, false)
       AND p.id NOT IN (SELECT pid FROM _paused)
       AND (p.ultima_fecha_jugada IS NULL OR p.ultima_fecha_jugada::date < v_today)
       AND NOT (COALESCE(p.victorias,0) = 0 AND COALESCE(p.derrotas,0) = 0);

  -- Observabilidad: ¿esta corrida tuvo un #1 sano (y por lo tanto congelado)?
  -- Se evalúa antes del reacomodo, con las posiciones de entrada.
  SELECT count(*) INTO n_lider
    FROM players WHERE activo AND posicion = 1 AND NOT COALESCE(lesionado, false);

  UPDATE players SET dias_inactivo = dias_inactivo + 1 WHERE id IN (SELECT id FROM _incr);

  -- Recalcula semanas para TODOS los activos, no solo los de _incr: por eso el #1
  -- congelado se mantiene consistente sin tratamiento especial.
  UPDATE players SET semanas_inactivo = floor(dias_inactivo / 7.0)::int
   WHERE activo AND semanas_inactivo IS DISTINCT FROM floor(dias_inactivo / 7.0)::int;

  -- Insignia automática a los 28 días. Sin exclusión del #1: el sano no está en
  -- _incr (su reloj no avanza, no puede cruzar el umbral) y el lesionado ya tiene
  -- la insignia.
  UPDATE players
     SET lesionado = true, lesion_fecha = now(),
         lesion_nota = CASE WHEN COALESCE(lesion_nota,'') = '' THEN 'Inactividad (4 semanas)' ELSE lesion_nota END
   WHERE id IN (SELECT id FROM _incr) AND dias_inactivo = 28;
  GET DIAGNOSTICS n_les = ROW_COUNT;

  -- Penalizaciones. Sin exclusión del #1, por la misma razón: la pertenencia a
  -- _incr ya deja fuera al #1 sano, y el #1 lesionado DEBE entrar.
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

  -- (El ocupante de la posición 1 SÍ puede cambiar dentro del cron: si el #1 está
  --  lesionado entra en _pen y baja. No hay nada que re-normalizar: el nuevo #1
  --  simplemente queda fuera de _incr desde la corrida siguiente, conservando el
  --  reloj que traía.)

  IF movio THEN UPDATE v2_config SET last_cron_movement_at = now() WHERE id = 1; END IF;
  UPDATE v2_config SET last_cron_daily_date = v_today WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'fecha', v_today, 'expirados', n_exp,
    'penalizados', n_pen, 'lesionados_nuevos', n_les, 'lider_congelado', n_lider,
    'movio', movio, 'movimientos', moved);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'cron_diario falló: %', SQLERRM;
END;
$function$;
