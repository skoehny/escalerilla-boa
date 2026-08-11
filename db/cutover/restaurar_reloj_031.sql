-- #####################################################################
-- ##  DESCARTADO — NO SE CORRIÓ EN PRODUCCIÓN. NO LO CORRAS.         ##
-- #####################################################################
--
-- DECISIÓN (2026-08-10, Sebastián): la remediación NO se ejecuta. La regla nueva
-- estrena con el reloj limpio.
--
-- MOTIVO
--   El 0 de Gabriel Rubilar no viene de su comportamiento: viene de reparar un
--   error del sistema (el cron lo penalizó estando en la #1). Reponerle 14 días de
--   inactividad sería hacerle cargar con la consecuencia de un bug nuestro. Se
--   prefiere estrenar la regla de congelamiento partiendo de cero: desde acá, todo
--   lo que muestre su reloj será producto de la regla nueva y no del incidente.
--   Felipe Larrain queda igual, con su déficit de 2 días — irrelevante frente a un
--   umbral de 14, y desaparece solo en cuanto juegue.
--
-- ⚠ POR QUÉ ESTE AVISO Y NO BORRAR EL ARCHIVO
--   Se conserva como registro del análisis (el cálculo del offset y por qué no se
--   puede reconstruir el reloj desde ultima_fecha_jugada siguen siendo válidos y
--   útiles si algún día hay que rehacer algo parecido).
--   Y OJO: las guardas de idempotencia del PASO 2 **no protegen contra correrlo por
--   error**. Esas guardas buscan el rastro que deja la propia restauración en
--   ranking_log — y como nunca se corrió, ese rastro no existe: el script se
--   ejecutaría completo y modificaría los relojes de los dos jugadores. La única
--   protección real es este aviso.
--
-- Historia completa del episodio: db/cutover/aplicado_prod_030_031.md
-- #####################################################################

-- REMEDIACIÓN DE DATOS tras la mig 031 (one-shot, PROD, a mano)
-- =====================================================================
-- GABRIEL RUBILAR VUELVE A ESTAR EN ESTE SCRIPT
--   En la versión anterior lo habíamos sacado, con este argumento: "un #1 sano
--   tiene el reloj en 0, así que su 0 ya es el estado correcto". Ese argumento
--   valía para la 031 que normalizaba a 0 — y esa versión se descartó por el
--   exploit del ciclo lesión/alta. La 031 final CONGELA el reloj en su valor, no
--   lo borra: un #1 sano con reloj congelado en 14 es un estado perfectamente
--   representable y verdadero. Por lo tanto el 0 de Gabriel vuelve a ser un dato
--   perdido, y ahora además IMPORTA: si algún día se lesiona, su reloj arrancaría
--   desde 0 en vez de desde 14, regalándole 14 días extra de punta bloqueada —
--   justo lo que este diseño existe para evitar.
--
-- POR QUÉ
--   • Gabriel Rubilar (#1): db/cutover/incidente_lider_inactividad.sql le dejó
--     dias_inactivo = 0. Su contador real al momento de la reparación era 14.
--   • Felipe Larrain: ocupaba la #1 cuando se aplicó la 030 y la normalización
--     one-shot de esa migración le puso 0 cuando tenía 2 días. Estaba en la #1
--     SOLO por el incidente (el cron había bajado indebidamente a Gabriel): en el
--     mundo sin ese bug nunca fue #1 y su reloj habría seguido acumulando. Arrastra
--     un déficit permanente de 2 días, así que sus umbrales llegan 2 días tarde.
--
-- CÓMO SE CALCULA N
--   El reloj es un CONTADOR INCREMENTAL, no una diferencia de fechas: respeta las
--   pausas por desafío activo y los congelamientos. Reconstruirlo desde
--   ultima_fecha_jugada obligaría a re-deducir esas pausas día por día con datos
--   que no se guardan (los challenges solo tienen su estado ACTUAL). El camino
--   exacto y auditable es reponer el offset perdido:
--
--       N = dias_inactivo (actual) + offset perdido
--
--       Gabriel: N = dias_inactivo + 14
--       Felipe : N = dias_inactivo +  2
--
--   Los días transcurridos desde cada cero ya están dentro del dias_inactivo actual
--   (el cron los fue sumando descontando pausas y freezes correctamente); sumar el
--   offset reconstruye el valor real sin volver a razonar sobre pausas. Ojo con
--   Gabriel: con la 030 vigente en prod su reloj está clavado en 0 (esa versión lo
--   normaliza cada día), así que hasta que apliques la 031 su dias_inactivo será 0
--   y N será exactamente 14.
--
--   Verificación cruzada (paso 1, columna dias_calendario): en un período sin
--   desafíos ni freezes, N debería quedar cerca de (hoy - ultima_fecha_jugada)
--   menos dias_ajuste_saneo. Si la diferencia es grande, hubo pausas reales —
--   revísalas antes de correr el paso 2.
--
-- EFECTO VISIBLE DESPUÉS DE CORRERLO
--   Gabriel, siendo #1 sano, mostrará "congelado (#1 desafiable)" con 14 días, y
--   el badge de inactividad en el Ranking. Es información verdadera y no impide
--   que lo desafíen. Su reloj no avanza mientras siga sano en la punta, y se
--   reinicia a 0 en cuanto juegue.
--
-- GUARDAS DEL PASO 2
--   • No hace nada si el jugador jugó DESPUÉS del cero (su reloj ya se reinició
--     legítimamente y no hay nada que reponer).
--   • No hace nada si ya se corrió antes (busca su propio rastro en ranking_log).
--   • Usa admin_ajustar_reloj, que recalcula semanas_inactivo y deja log 'admin'.
--   (Ya NO hay guarda por "está en la #1": con el reloj congelado en vez de
--    normalizado, estar en la punta no obliga a que el contador valga 0.)
--
-- ORDEN: aplica primero db/sql/031_lider_reloj_condicional.sql. Correrlo con la
--   030 todavía vigente sería inútil para Gabriel: el cron del día siguiente le
--   volvería a poner 0.
-- =====================================================================

-- ── PASO 1 · DIAGNÓSTICO: estado actual y N propuesto ─────────────────
SELECT p.nombre || ' ' || p.apellido            AS jugador,
       p.posicion,
       p.dias_inactivo                          AS reloj_actual,
       CASE WHEN p.apellido = 'Rubilar' THEN 14 ELSE 2 END AS offset_perdido,
       p.dias_inactivo + CASE WHEN p.apellido = 'Rubilar' THEN 14 ELSE 2 END AS n_propuesto,
       p.ultima_fecha_jugada::date              AS ultimo_partido,
       (CURRENT_DATE - p.ultima_fecha_jugada::date) AS dias_calendario,
       p.dias_ajuste_saneo,
       p.lesionado, p.lesion_nota
  FROM players p
 WHERE p.activo
   AND (p.nombre, p.apellido) IN (('Gabriel','Rubilar'), ('Felipe','Larrain'))
 ORDER BY p.posicion;

-- Los ceros que estamos revirtiendo, tal como quedaron en el log.
SELECT p.nombre || ' ' || p.apellido AS jugador, l.created_at, l.causa, l.detalle
  FROM ranking_log l JOIN players p ON p.id = l.player_id
 WHERE (p.nombre, p.apellido) IN (('Gabriel','Rubilar'), ('Felipe','Larrain'))
   AND l.created_at > now() - interval '30 days'
 ORDER BY l.created_at DESC;

-- Contexto de pausas del período (para la verificación cruzada de arriba).
SELECT c.id, c.status, c.created_at, c.deadline,
       ch.apellido AS challenger, cd.apellido AS challenged
  FROM challenges c
  JOIN players ch ON ch.id = c.challenger_id
  JOIN players cd ON cd.id = c.challenged_id
 WHERE c.created_at > now() - interval '45 days'
   AND (ch.apellido IN ('Rubilar','Larrain') OR cd.apellido IN ('Rubilar','Larrain'))
 ORDER BY c.created_at DESC;

SELECT * FROM reloj_freeze_log WHERE congelado_desde > now() - interval '45 days';

-- ── PASO 2 · RESTAURACIÓN ─────────────────────────────────────────────
DO $$
DECLARE
  r          record;
  v_id       uuid;
  v_dias     integer;
  v_ult      timestamptz;
  v_marca_at timestamptz;
  v_n        integer;
  c_motivo   constant text := 'restauración contador real tras cambio de diseño 031';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- nombre, apellido, offset perdido, detalle del log que puso el 0
      ('Gabriel', 'Rubilar', 14, 'reloj a 0: exención del #1 (incidente de inactividad)'),
      ('Felipe',  'Larrain',  2, 'exención del #1: el líder no acumula reloj')
    ) AS t(nombre, apellido, offset_perdido, marca)
  LOOP
    SELECT id, dias_inactivo, ultima_fecha_jugada INTO v_id, v_dias, v_ult
      FROM players WHERE activo AND nombre = r.nombre AND apellido = r.apellido;

    IF v_id IS NULL THEN
      RAISE NOTICE '% %: no hay un jugador activo con ese nombre — se salta.', r.nombre, r.apellido;
      CONTINUE;
    END IF;

    -- Idempotencia: ¿ya se corrió esta restauración?
    IF EXISTS (SELECT 1 FROM ranking_log
                WHERE player_id = v_id AND causa = 'admin' AND detalle LIKE c_motivo || '%') THEN
      RAISE NOTICE '% %: la restauración ya se aplicó antes — se salta.', r.nombre, r.apellido;
      CONTINUE;
    END IF;

    -- ¿Cuándo se le puso el 0?
    SELECT max(created_at) INTO v_marca_at
      FROM ranking_log WHERE player_id = v_id AND detalle = r.marca;

    IF v_marca_at IS NULL THEN
      RAISE NOTICE '% %: no encuentro el evento "%" en ranking_log — revisa a mano.',
        r.nombre, r.apellido, r.marca;
      CONTINUE;
    END IF;

    -- Si jugó después, su reloj se reinició legítimamente: no hay nada que reponer.
    IF v_ult IS NOT NULL AND v_ult > v_marca_at THEN
      RAISE NOTICE '% %: jugó el % (posterior al 0 del %) — su reloj es correcto, se salta.',
        r.nombre, r.apellido, v_ult::date, v_marca_at::date;
      CONTINUE;
    END IF;

    v_n := v_dias + r.offset_perdido;
    PERFORM admin_ajustar_reloj(v_id, v_n, c_motivo);
    RAISE NOTICE '% %: reloj % + % (offset perdido el %) => % días.',
      r.nombre, r.apellido, v_dias, r.offset_perdido, v_marca_at::date, v_n;
  END LOOP;
END $$;

-- ── PASO 3 · VERIFICACIÓN ─────────────────────────────────────────────
SELECT posicion, nombre, apellido, dias_inactivo, semanas_inactivo, lesionado, lesion_nota
  FROM players WHERE activo AND posicion IS NOT NULL ORDER BY posicion LIMIT 10;

SELECT p.nombre || ' ' || p.apellido AS jugador, l.created_at, l.detalle
  FROM ranking_log l JOIN players p ON p.id = l.player_id
 WHERE l.causa = 'admin' AND l.detalle LIKE 'restauración contador real tras cambio de diseño 031%'
 ORDER BY l.created_at DESC;
