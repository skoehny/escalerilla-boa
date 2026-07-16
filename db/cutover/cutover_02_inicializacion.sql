-- =====================================================================
-- CUTOVER 02 — INICIALIZACIÓN (ejecutar DESPUÉS de cutover_01)
-- =====================================================================
-- Deja la configuración y los relojes en un estado coherente para el estreno.
-- Los pasos (a)–(d) son seguros de correr ANTES de las 16:00 UTC del jueves.
-- El (e) es el ESTRENO de la foto y va al final, ya verificado todo.
-- =====================================================================

-- (a) GUARD ANTI-CARRERA DE LA FOTO — EJECUTAR PRIMERO, sin demora tras la 01.
-- cutover_01 ya dejó agendado el cron v2_foto_jueves (0 16 * * 4). Marcando la
-- fecha de hoy, el disparo automático de las 16:00 UTC se SALTA mientras trabajo.
UPDATE v2_config SET last_foto_jueves_date = current_date WHERE id = 1;

-- (b) CONFIG COMPLETA — valores definitivos de producción.
UPDATE v2_config SET
  ventana_validacion_minutos = 1440,     -- 24 h para validar/corregir
  dias_expiracion_desafio    = 7,        -- caducidad de un desafío
  horas_wo_cancelacion       = 24,       -- umbral de WO por cancelación tardía
  max_puestos_desafio        = 4,        -- rango de desafío hacia arriba
  formato_partido            = 'set9',   -- formato de estreno
  nombre_club                = 'Club BOA',
  last_cron_daily_date       = current_date,  -- el cron diario de hoy no re-corre
  last_cron_movement_at      = NULL
WHERE id = 1;

-- (c) SANEO DE JUGADORES ------------------------------------------------------
-- Descongelar el reloj de todos (estado limpio de estreno).
UPDATE players SET inactividad_congelada = false WHERE activo;

-- Diagnóstico (SOLO SELECT): activos con historial (v+d>0) pero SIN fecha de
-- último partido. En estos, el cron diario NO puede medir inactividad hasta que
-- se les fije una fecha base.
--   → Si aparecen filas, sanearlos con (ejemplo, elegí la fecha base adecuada):
--       UPDATE players SET ultima_fecha_jugada = now()
--        WHERE activo AND ultima_fecha_jugada IS NULL
--          AND (COALESCE(victorias,0) + COALESCE(derrotas,0)) > 0;
--   (Los debutantes con v=0 y d=0 NO tienen reloj: es correcto que queden NULL.)
SELECT id, nombre, apellido, posicion, victorias, derrotas, ultima_fecha_jugada
  FROM players
 WHERE activo
   AND (COALESCE(victorias,0) + COALESCE(derrotas,0)) > 0
   AND ultima_fecha_jugada IS NULL
 ORDER BY posicion;

-- (d) WILDCARD RESET ANUAL -----------------------------------------------------
-- Primero consultar si ya existe un cron de wildcard:
SELECT * FROM cron.job WHERE jobname ILIKE '%wildcard%';
-- Si la consulta anterior NO devuelve filas, agendar el reset anual
-- (1 de enero 00:00). Descomentar y ejecutar:
--   SELECT cron.schedule(
--     'yearly-wildcard-reset',
--     '0 0 1 1 *',
--     $$UPDATE players SET wildcard_usada = false$$
--   );

-- =====================================================================
-- (e) PASO FINAL — EJECUTAR SOLO CUANDO TODO LO ANTERIOR ESTÉ VERIFICADO
-- =====================================================================
-- Estreno de la foto de la semana nueva. Levanta el guard de (a) y publica.
-- Alternativa: si son las 16:00 UTC y preferís que dispare el cron, NO corras
-- esto y dejá que v2_foto_jueves lo haga (requiere last_foto_jueves_date <> hoy;
-- ver README, escenario "después de las 16:00 UTC").
--
--   UPDATE v2_config SET last_foto_jueves_date = NULL WHERE id = 1;
--   SELECT foto_jueves();  -- estreno: foto de la semana nueva
-- =====================================================================
