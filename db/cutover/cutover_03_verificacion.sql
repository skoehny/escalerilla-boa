-- =====================================================================
-- CUTOVER 03 — VERIFICACIÓN (solo SELECTs; no muta nada)
-- =====================================================================
-- Correr por SECCIONES. La FASE 0 va ANTES de todo (sobre prod tal cual, para
-- confirmar que el esquema base pre-010 existe). El resto, después de cada fase.
-- =====================================================================


-- ┌───────────────────────────────────────────────────────────────────┐
-- │ FASE 0 — PRE-FLIGHT: dependencias que el cutover ASUME preexistentes │
-- │ (NO las crean las migraciones 010–024). Si algo falta → DETENER.     │
-- └───────────────────────────────────────────────────────────────────┘

-- 0.1 Tablas base requeridas (esperado: las 6 con 'ok')
SELECT t.name AS tabla,
       CASE WHEN c.table_name IS NULL THEN 'FALTA ***' ELSE 'ok' END AS estado
  FROM (VALUES ('challenges'),('players'),('v2_config'),('weekly_config'),
               ('ranking_history'),('ranking_log')) AS t(name)
  LEFT JOIN information_schema.tables c
    ON c.table_schema='public' AND c.table_name=t.name
 ORDER BY t.name;
-- Nota: ranking_log la crea la mig 016; puede figurar 'FALTA' ANTES de cutover_01
-- (es correcto). Las otras 5 DEBEN existir ya en prod.

-- 0.2 Columnas base pre-010 requeridas por funciones/crons v2.
-- En PROD (respaldo 2026-07-16) figuran 'FALTA' ANTES de cutover_00b:
--   challenges.disputado, challenges.resultado_ingresado_at, challenges.disputa_motivo,
--   y las 3 de v2_config (la tabla misma no existe → 0.1). Las crea cutover_00b.
-- Tras 00b + 01: todas deben quedar 'ok'.
SELECT d.tabla, d.col,
       CASE WHEN c.column_name IS NULL THEN 'FALTA ***' ELSE 'ok' END AS estado
  FROM (VALUES
        ('challenges','ganador'),('challenges','score_a'),('challenges','score_b'),
        ('challenges','status'),('challenges','ranking_applied'),('challenges','disputado'),
        ('challenges','resultado_validado'),('challenges','resultado_ingresado_at'),
        ('challenges','disputa_motivo'),
        ('challenges','anotado_por'),('challenges','validado_por'),('challenges','deadline'),
        ('challenges','is_wo'),('challenges','is_wildcard'),('challenges','slot_day'),
        ('challenges','slot_court'),('challenges','slot_hour'),('challenges','challenger_id'),
        ('challenges','challenged_id'),
        ('players','victorias'),('players','derrotas'),('players','posicion'),
        ('players','posicion_anterior'),('players','activo'),('players','lesionado'),
        ('players','lesion_nota'),('players','lesion_fecha'),('players','wildcard_usada'),
        ('players','ultima_fecha_jugada'),('players','semanas_inactivo'),('players','es_admin'),
        ('v2_config','ventana_validacion_minutos'),('v2_config','dias_expiracion_desafio'),
        ('v2_config','horas_wo_cancelacion')
       ) AS d(tabla,col)
  LEFT JOIN information_schema.columns c
    ON c.table_schema='public' AND c.table_name=d.tabla AND c.column_name=d.col
 ORDER BY d.tabla, d.col;

-- 0.3 Trigger que estampa resultado_ingresado_at (esperado: 1 fila).
-- En PROD devuelve 0 filas ANTES de cutover_00b (prod tiene 0 triggers) → lo crea 00b.
SELECT trigger_name, action_timing, event_manipulation
  FROM information_schema.triggers
 WHERE event_object_table='challenges' AND trigger_name='trg_stamp_resultado';

-- 0.4 Fila de configuración id=1 (esperado: 1 fila) y weekly_config id=1
SELECT (SELECT count(*) FROM v2_config    WHERE id=1) AS v2_config_id1,
       (SELECT count(*) FROM weekly_config WHERE id=1) AS weekly_config_id1;

-- 0.5 Índice único ranking_history(semana) — lo usa foto_jueves (ON CONFLICT).
-- Agnóstico al nombre (en prod se llama ranking_history_semana_unique). Esperado: 1 fila.
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname='public' AND tablename='ranking_history'
   AND indexdef ILIKE '%UNIQUE%(semana)%';


-- ┌───────────────────────────────────────────────────────────────────┐
-- │ FASE A — DESPUÉS de cutover_00 + cutover_01                          │
-- └───────────────────────────────────────────────────────────────────┘

-- A.1 Funciones esperadas (esperado: TODAS 'ok'; 18 en total)
SELECT f.name AS funcion,
       CASE WHEN p.proname IS NULL THEN 'FALTA ***' ELSE 'ok' END AS estado
  FROM (VALUES
        ('recalcular_stats'),('aplicar_pendientes'),        -- prereqs (cutover_00)
        ('aplicar_resultado'),('validar_resultado'),('corregir_resultado'),
        ('crear_desafio'),('cron_diario'),('foto_jueves'),('marcar_wo'),
        ('validar_marcador'),('_set6_winner'),('admin_ajustar_posicion'),
        ('admin_perdonar_inactividad'),('admin_ajustar_reloj'),
        ('admin_congelar_inactividad'),('admin_descongelar_inactividad'),
        ('admin_activar_jugador'),('admin_inactivar_jugador')
       ) AS f(name)
  LEFT JOIN pg_proc p
    ON p.proname=f.name
   AND p.pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')
 ORDER BY estado DESC, f.name;

-- A.2 Sin overload de corregir_resultado / marcar_wo (esperado: 1 y 1)
SELECT proname, count(*) AS firmas
  FROM pg_proc
 WHERE pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')
   AND proname IN ('corregir_resultado','marcar_wo')
 GROUP BY proname ORDER BY proname;

-- A.3 Columnas NUEVAS que agregan las migraciones (esperado: todas 'ok')
SELECT d.tabla, d.col,
       CASE WHEN c.column_name IS NULL THEN 'FALTA ***' ELSE 'ok' END AS estado
  FROM (VALUES
        ('challenges','snapshot_pre'),('challenges','applied_at'),
        ('challenges','cancelled_at'),('challenges','cancelled_by'),('challenges','sets'),
        ('players','dias_inactivo'),('players','inactividad_congelada'),
        ('v2_config','max_puestos_desafio'),('v2_config','formato_partido'),
        ('v2_config','nombre_club'),('v2_config','last_cron_daily_date'),
        ('v2_config','last_cron_movement_at'),('v2_config','last_foto_jueves_date')
       ) AS d(tabla,col)
  LEFT JOIN information_schema.columns c
    ON c.table_schema='public' AND c.table_name=d.tabla AND c.column_name=d.col
 ORDER BY d.tabla, d.col;

-- A.4 Crons agendados (esperado: los 3 v2_*; wildcard aparece tras cutover_02d)
SELECT jobname, schedule, active
  FROM cron.job
 WHERE jobname IN ('v2_aplicar_pendientes','v2_cron_diario','v2_foto_jueves','yearly-wildcard-reset')
 ORDER BY jobname;
-- Esperado (mínimo): v2_aplicar_pendientes '*/5 * * * *', v2_cron_diario '0 8 * * *',
--                    v2_foto_jueves '0 16 * * 4'.


-- ┌───────────────────────────────────────────────────────────────────┐
-- │ FASE B — DESPUÉS de cutover_02 (a–d)                                 │
-- └───────────────────────────────────────────────────────────────────┘

-- B.1 Config completa (esperado: 1440 / 7 / 24 / 4 / set9 / Club BOA / hoy / NULL)
SELECT ventana_validacion_minutos, dias_expiracion_desafio, horas_wo_cancelacion,
       max_puestos_desafio, formato_partido, nombre_club,
       last_cron_daily_date, last_cron_movement_at, last_foto_jueves_date
  FROM v2_config WHERE id=1;
-- Antes del PASO FINAL (e): last_foto_jueves_date = hoy (guard activo).

-- B.2 Integridad de posiciones (esperado: duplicados=0 y sin_huecos=true)
SELECT
  (SELECT count(*) FROM (
     SELECT posicion FROM players WHERE activo AND posicion IS NOT NULL
      GROUP BY posicion HAVING count(*)>1) x) AS duplicados,
  (SELECT COALESCE(max(posicion),0) FROM players WHERE activo AND posicion IS NOT NULL)
    = (SELECT count(*) FROM players WHERE activo AND posicion IS NOT NULL) AS sin_huecos;

-- B.3 Congelamiento saneado (esperado: 0 congelados)
SELECT count(*) AS congelados FROM players WHERE inactividad_congelada;


-- ┌───────────────────────────────────────────────────────────────────┐
-- │ FASE C — DESPUÉS del PASO FINAL (e): estreno de la foto             │
-- └───────────────────────────────────────────────────────────────────┘

-- C.1 Última foto publicada (esperado: 1 fila nueva, publicado_por='auto', hoy)
SELECT semana, fecha, publicado_por, hora_publicacion,
       jsonb_array_length(data) AS jugadores,
       jsonb_array_length(movimientos->'movements') AS movimientos,
       jsonb_array_length(movimientos->'notas') AS notas
  FROM ranking_history
 ORDER BY semana DESC
 LIMIT 1;

-- C.2 last_foto_jueves_date debe volver a hoy tras foto_jueves (esperado: hoy)
SELECT last_foto_jueves_date FROM v2_config WHERE id=1;
