-- =====================================================================
-- HALLAZGO 3 — Saneo de ultima_fecha_jugada + recálculo de dias_inactivo
-- =====================================================================
-- Problema: en prod, ultima_fecha_jugada de algunos jugadores no refleja su
-- último partido real (venía de v1 / migración), así que el reloj de inactividad
-- (dias_inactivo) arranca torcido.
--
-- Corrección (regla dada):
--   ultima_fecha_jugada := MAYOR( valor actual , slot_day del ÚLTIMO challenge
--                                  del jugador con ganador y ranking_applied ).
--   dias_inactivo       := días entre esa fecha y HOY (UTC), piso 0.
--   semanas_inactivo    := floor(dias_inactivo / 7).
--
-- Alcance: solo jugadores ACTIVOS y NO debutantes (victorias=0 y derrotas=0 no
-- tienen reloj). Solo se tocan filas que efectivamente cambian.
--
-- SUPUESTO (verificar en la simulación): no hay desafíos pending/accepted ni
-- jugadores congelados ahora mismo, así que "días desde el último partido" es el
-- baseline correcto (el cron maneja las pausas de acá en adelante).
-- =====================================================================
-- SECUENCIA REALMENTE APLICADA EN PROD (2026-07-16), para la bitácora:
--   1. BLOQUE B de este archivo (saneo de ufj + recálculo de dias/semanas con
--      las decisiones a/b/c de abajo).
--   2. Corrección a la baja de pausados con contador inflado (manual).
--   3. Regla de TRANSICIÓN: se redondearon todos los dias_inactivo hacia abajo
--      al múltiplo de 7 más cercano (lesionados incluidos), para arrancar la v2
--      con relojes "en semanas cerradas". (Ajuste puntual manual del admin.)
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE A — SIMULACIÓN (SOLO LECTURA): quiénes cambiarían y a qué valor
-- ─────────────────────────────────────────────────────────────────────
WITH base AS (
  SELECT p.id, p.nombre, p.apellido, p.posicion,
         p.ultima_fecha_jugada AS ufj_act,
         p.dias_inactivo       AS dias_act,
         p.semanas_inactivo    AS sem_act,
         ( SELECT max(CASE WHEN c.slot_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN c.slot_day::date END)
             FROM challenges c
            WHERE (c.challenger_id = p.id OR c.challenged_id = p.id)
              AND c.ganador IS NOT NULL AND c.ranking_applied = true ) AS last_play,
         ( SELECT count(*) FROM challenges c
            WHERE (c.challenger_id = p.id OR c.challenged_id = p.id)
              AND c.ganador IS NOT NULL AND c.ranking_applied = true
              AND (c.slot_day IS NULL OR c.slot_day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') ) AS applied_sin_slotday
    FROM players p
   WHERE p.activo
     AND NOT (COALESCE(p.victorias,0)=0 AND COALESCE(p.derrotas,0)=0)
),
calc AS (
  SELECT *,
         GREATEST(ufj_act, last_play::timestamp) AS ufj_new
    FROM base
),
final AS (
  SELECT *,
         CASE WHEN ufj_new IS NULL THEN NULL
              ELSE GREATEST(0, ((now() AT TIME ZONE 'UTC')::date - ufj_new::date))::int END AS dias_new
    FROM calc
)
SELECT nombre, apellido, posicion,
       ufj_act::date AS ufj_actual, last_play, ufj_new::date AS ufj_nueva,
       dias_act AS dias_actual, dias_new AS dias_nueva,
       sem_act  AS sem_actual,  floor(dias_new/7.0)::int AS sem_nueva,
       (ufj_act IS DISTINCT FROM ufj_new)   AS cambia_fecha,
       (dias_act IS DISTINCT FROM dias_new) AS cambia_dias,
       applied_sin_slotday
  FROM final
 WHERE ufj_new IS NOT NULL
   AND ( ufj_act IS DISTINCT FROM ufj_new OR dias_act IS DISTINCT FROM dias_new )
 ORDER BY cambia_dias DESC, posicion;

-- ─────────────────────────────────────────────────────────────────────
-- BLOQUE B — EL UPDATE (ejecutar en un momento tranquilo; una transacción)
-- ─────────────────────────────────────────────────────────────────────
-- Decisiones aplicadas:
--   (a) los jugadores con desafío pending/accepted (en pausa) NO recalculan
--       dias/semanas (su reloj está pausado; al jugar quedan en 0 solos).
--   (b) ultima_fecha_jugada SÍ se corrige para TODOS (dato factual), incluso
--       para los pausados.
--   (c) solo se corrigen contadores: sin penalización de posición ni lesión.
--
-- Para ENSAYAR sin escribir: cambiá el COMMIT final por ROLLBACK (el RETURNING
-- igual te muestra qué cambiaría).
BEGIN;

WITH base AS (
  SELECT p.id,
         p.ultima_fecha_jugada AS ufj_act,
         EXISTS ( SELECT 1 FROM challenges c
                   WHERE c.status IN ('pending','accepted')
                     AND (c.challenger_id = p.id OR c.challenged_id = p.id) ) AS en_pausa,
         ( SELECT max(CASE WHEN c.slot_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN c.slot_day::date END)
             FROM challenges c
            WHERE (c.challenger_id = p.id OR c.challenged_id = p.id)
              AND c.ganador IS NOT NULL AND c.ranking_applied = true ) AS last_play
    FROM players p
   WHERE p.activo
     AND NOT (COALESCE(p.victorias,0)=0 AND COALESCE(p.derrotas,0)=0)
),
final AS (
  SELECT id, ufj_act, en_pausa,
         GREATEST(ufj_act, last_play::timestamp) AS ufj_new
    FROM base
)
UPDATE players p
   SET ultima_fecha_jugada = f.ufj_new,
       dias_inactivo    = CASE WHEN f.en_pausa THEN p.dias_inactivo
                               ELSE GREATEST(0, ((now() AT TIME ZONE 'UTC')::date - f.ufj_new::date))::int END,
       semanas_inactivo = CASE WHEN f.en_pausa THEN p.semanas_inactivo
                               ELSE floor(GREATEST(0, ((now() AT TIME ZONE 'UTC')::date - f.ufj_new::date))/7.0)::int END
  FROM final f
 WHERE p.id = f.id
   AND f.ufj_new IS NOT NULL
   AND (
        p.ultima_fecha_jugada IS DISTINCT FROM f.ufj_new
        OR ( NOT f.en_pausa
             AND p.dias_inactivo IS DISTINCT FROM GREATEST(0, ((now() AT TIME ZONE 'UTC')::date - f.ufj_new::date))::int )
   )
RETURNING p.posicion, p.nombre, p.apellido,
          p.ultima_fecha_jugada::date AS ufj, p.dias_inactivo, p.semanas_inactivo,
          f.en_pausa;

COMMIT;   -- ← cambiá por ROLLBACK para ensayar sin escribir
