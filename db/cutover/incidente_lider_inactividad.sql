-- INCIDENTE — el #1 fue penalizado por inactividad (reparación manual, PROD)
-- =====================================================================
-- QUÉ PASÓ
--   cron_diario penalizó por inactividad al jugador que ocupaba la posición #1 y
--   lo bajó de puesto. Es un error de diseño: el #1 no puede desafiar a nadie, así
--   que su inactividad no depende de él. La regla permanente que lo impide de aquí
--   en adelante está en db/sql/030_exencion_lider.sql — APLICA LA 030 PRIMERO.
--
-- QUÉ HACE ESTE SCRIPT (one-shot, idempotente, solo datos)
--   1. Devuelve al jugador a la posición 1 vía admin_ajustar_posicion (que ya
--      desplaza +1 a los que estaban entre la 1 y su posición actual — inversa
--      exacta de la penalización, que lo bajó N y subió 1 a los N de abajo).
--   2. Deja su reloj limpio: dias_inactivo = 0, semanas_inactivo = 0 y le quita la
--      insignia de lesionado SOLO si se la puso el cron por inactividad.
--   3. Deja rastro en ranking_log (causa 'admin').
--
-- GUARDA DE SEGURIDAD
--   Aborta si después de la penalización se aplicó algún RESULTADO que movió el
--   ranking (ranking_log causa 'resultado' posterior a la penalización). En ese
--   caso el orden actual ya no es "el de antes menos la penalización" y hay que
--   decidir a mano el ranking correcto.
--
-- CÓMO USARLO (Supabase SQL editor, base de PRODUCCIÓN)
--   a) Ajusta p_nombre / p_apellido abajo si el afectado no es Gabriel Rubilar.
--   b) Corre la consulta "ANTES" y guarda el resultado.
--   c) Corre el bloque DO.
--   d) Corre la consulta "DESPUÉS" y compara.
-- =====================================================================

-- ── ANTES: foto del top del ranking + últimos movimientos del afectado ──
SELECT posicion, nombre, apellido, dias_inactivo, semanas_inactivo, lesionado, lesion_nota
  FROM players WHERE activo AND posicion IS NOT NULL ORDER BY posicion LIMIT 10;

SELECT l.created_at, l.causa, l.detalle, l.desde, l.hasta
  FROM ranking_log l JOIN players p ON p.id = l.player_id
 WHERE p.nombre = 'Gabriel' AND p.apellido = 'Rubilar'
 ORDER BY l.created_at DESC LIMIT 10;

-- ── REPARACIÓN ────────────────────────────────────────────────────────
DO $$
DECLARE
  p_nombre   text := 'Gabriel';
  p_apellido text := 'Rubilar';
  v_id       uuid;
  v_pos      integer;
  v_pen_at   timestamptz;
  v_res_at   timestamptz;
BEGIN
  SELECT id, posicion INTO v_id, v_pos
    FROM players WHERE activo AND nombre = p_nombre AND apellido = p_apellido;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No hay un jugador activo llamado % %', p_nombre, p_apellido;
  END IF;

  -- Penalización por inactividad más reciente que efectivamente lo bajó desde la #1.
  SELECT max(created_at) INTO v_pen_at
    FROM ranking_log
   WHERE player_id = v_id AND causa = 'inactividad'
     AND detalle = 'penalización por inactividad' AND desde = 1;

  IF v_pen_at IS NULL THEN
    RAISE NOTICE 'No hay penalización por inactividad desde la #1 para % % — nada que reparar.', p_nombre, p_apellido;
    RETURN;
  END IF;

  -- Guarda: ningún resultado movió el ranking después de la penalización.
  SELECT max(created_at) INTO v_res_at
    FROM ranking_log WHERE causa = 'resultado' AND created_at > v_pen_at;

  IF v_res_at IS NOT NULL THEN
    RAISE EXCEPTION 'Hubo resultados aplicados después de la penalización (último: %). Revisa el ranking a mano antes de revertir.', v_res_at;
  END IF;

  IF v_pos <> 1 THEN
    PERFORM admin_ajustar_posicion(
      v_id, 1,
      'reparación incidente: el #1 no acumula inactividad — se revierte la penalización del cron');
  END IF;

  -- Reloj limpio. La insignia de lesionado se quita solo si la puso el cron.
  UPDATE players
     SET dias_inactivo    = 0,
         semanas_inactivo = 0,
         lesionado    = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN false ELSE lesionado END,
         lesion_nota  = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN ''    ELSE lesion_nota END,
         lesion_fecha = CASE WHEN lesion_nota = 'Inactividad (4 semanas)' THEN NULL  ELSE lesion_fecha END
   WHERE id = v_id;

  INSERT INTO ranking_log (player_id, causa, detalle, desde, hasta)
  VALUES (v_id, 'admin', 'reloj a 0: exención del #1 (incidente de inactividad)', 1, 1);

  RAISE NOTICE 'Reparado: % % vuelve de la posición % a la #1 con el reloj en 0.', p_nombre, p_apellido, v_pos;
END $$;

-- ── DESPUÉS: verificación ─────────────────────────────────────────────
SELECT posicion, nombre, apellido, dias_inactivo, semanas_inactivo, lesionado, lesion_nota
  FROM players WHERE activo AND posicion IS NOT NULL ORDER BY posicion LIMIT 10;

-- Sanidad: posiciones 1..N sin huecos ni repetidos
SELECT count(*) AS jugadores, min(posicion) AS min_pos, max(posicion) AS max_pos,
       count(DISTINCT posicion) AS distintas
  FROM players WHERE activo AND posicion IS NOT NULL;
