# Aplicado a PRODUCCIÓN — El reloj de inactividad del #1 (mig 030 → 031)

**Fechas:** incidente y fix inmediato el 10/08/2026; diseño final (031) aplicado el 10/08/2026.
**Base:** producción `rnaqvfmuslddeecgscox`
**Aplicado por:** Sebastián, a mano vía el SQL editor del dashboard de Supabase
(regla del proyecto: `apply.mjs` bloquea prod; el SQL de prod nunca se aplica por conexión directa).

---

## 1. El incidente que lo originó

`cron_diario` penalizó por inactividad a **Gabriel Rubilar** estando en la **posición #1**:
cruzó el umbral de 14 días y bajó **2 puestos**.

Es un error de diseño, no un bug de implementación: el #1 **no puede desafiar a nadie**
(mig 016/028 — el desafiado debe tener menor posición), solo puede *ser* desafiado. Si nadie
lo desafía, su inactividad no depende de él y no puede castigarlo.

**Reparación (one-shot, `db/cutover/incidente_lider_inactividad.sql`):** se lo devolvió a la #1
con `admin_ajustar_posicion` —que desplaza +1 a los que estaban entre medio, inversa exacta de
la penalización— y se le dejó el reloj en 0. El script aborta si hubo resultados aplicados
después de la penalización (en ese caso el orden ya no es "el de antes menos la penalización").

---

## 2. Mig 030 — fix inmediato (`db/sql/030_exencion_lider.sql`)

Regla: **mientras un jugador ocupe la #1, su reloj no acumula**. Queda fuera de `_incr` y una
normalización lo mantiene en `dias_inactivo = 0`. Incluía una sentencia one-shot que normalizaba
al #1 del momento.

| | hash normalizado |
|---|---|
| antes (baseline mig 026) | `2c13ef9ad99a2a7808f3eb1633198540` |
| después (030) | `366f608998acf245d93b0454769cb545` |

**Efecto colateral de la one-shot:** cuando se aplicó, el #1 era **Felipe Larrain** (estaba ahí
solo por el incidente, porque Gabriel había bajado). La normalización le puso el reloj en 0
cuando tenía 2 días. Arrastra ese déficit hasta hoy.

### El hallazgo del CRLF — convención de hash del proyecto

El md5 crudo de la definición **no calza entre test y prod**: los applies por el dashboard de
Supabase convierten LF a CRLF, así que `pg_get_functiondef` devuelve el mismo código con otros
saltos de línea. Desde acá, la validación pre/post apply del proyecto usa la **fórmula
normalizada**:

```sql
SELECT md5(replace(pg_get_functiondef('public.cron_diario()'::regprocedure), chr(13), ''));
```

Todos los hashes de este documento son con esa fórmula.

---

## 3. Dos diseños intermedios descartados (y por qué)

La 030 resolvió el incidente pero abrió preguntas de diseño. Se recorrieron dos alternativas
antes de llegar a la definitiva; ninguna llegó a producción.

### 3.1 "El reloj del #1 corre y se ve, pero no lo penaliza"

**Idea:** el #1 acumula `dias_inactivo` normalmente (información visible: cuánto lleva sin jugar
el líder), pero queda fuera de `_pen` y de la insignia automática de lesionado.

**Exploit — umbrales fantasma.** ¿Qué pasa con los umbrales que el #1 cruza *mientras está
protegido*? Si al lesionarse (y por lo tanto volverse indesafiable) se le aplican de golpe, se
siente como castigo por declarar una lesión real. Si se ignoran, un #1 que se atrinchera 27 días
sano y recién ahí se declara lesionado **esquiva el −2 del día 14 y el −1 del 21**, y solo come
−1 el día 28. La protección se volvía explotable.

### 3.2 "Protegido mientras sea desafiable, con el reloj normalizado a 0"

**Idea:** el #1 **sano** tiene el reloj en pausa y en 0; el #1 **lesionado** —que es indesafiable
y bloquea la punta— lo tiene corriendo desde 0 con los umbrales normales. Los umbrales fantasma
desaparecen: al lesionarse parte de 0 y todo llega en orden natural.

**Exploit — ciclo lesión/alta.** Como el cron normalizaba a 0 en cada corrida en que el #1
estuviera sano:

> se lesiona (indesafiable, el reloj corre) → llega al día 13 → **se da de alta un día** (el cron
> lo normaliza a 0) → se lesiona de nuevo → el reloj parte de 0 otra vez.

Repetible para siempre: nunca cruza el 14, indesafiable casi todo el tiempo, punta bloqueada
indefinidamente.

---

## 4. Diseño final — mig 031 (`db/sql/031_lider_reloj_condicional.sql`)

**La protección del #1 vale mientras sea DESAFIABLE, y CONGELA el reloj en vez de borrarlo.**

- **#1 sano:** queda fuera de `_incr`, así que su reloj **no avanza pero conserva su valor**.
  Sin penalizaciones ni auto-lesión. Lo único que lo reinicia a 0 es **jugar**
  (`aplicar_resultado`).
- **#1 lesionado:** entra a `_incr` y el reloj corre **desde ese valor** con los umbrales
  normales (14: −2, 21: −1, 28: −1, y −1 cada 7). Un lesionado no puede ser desafiado, así que
  un #1 lesionado bloquearía la punta; el reloj es lo que la libera.

Congelar en vez de borrar hace el contador **monótono**: la suma de días lesionado nunca se
pierde, así que el umbral 14 llega sí o sí. Medido en test, cada vuelta del ciclo lesión/alta
gana **0 días de reloj** y cuesta **1 día desafiable**. El intercambio es honesto: para atrasar
el umbral N días hay que estar disponible N días.

### Invariantes de la implementación

- **Congelar = no ejecutar ningún UPDATE.** La pausa está implementada *únicamente* por la
  exclusión de `_incr`. La migración no lleva sentencia one-shot y no cambia ningún dato.
- **`_pen` y la auto-lesión no llevan filtro del #1.** No hace falta: ambos bloques dependen de
  pertenecer a `_incr`, y el #1 sano nunca entra. Por eso un `admin_ajustar_reloj` a 27 sobre el
  #1 sano lo deja congelado en 27 sin lesionarlo ni bajarlo (para limpiarlo de verdad la
  herramienta es `admin_perdonar_inactividad`, mig 022).
- **`semanas_inactivo` queda consistente solo:** el UPDATE global de semanas recalcula para
  *todos* los activos, no solo para los de `_incr`.
- La condición usa `IS DISTINCT FROM` para que un activo con `posicion NULL` siga entrando a
  `_incr` igual que antes.

### Decisiones de visibilidad (tomadas, no efectos colaterales)

Un #1 sano puede mostrar ahora un reloj congelado ≥ 7, así que aparece con badge de inactividad
en `Ranking.jsx` y en las notas de `foto_jueves`. **Se acepta:** es información verdadera —cuánto
lleva sin jugar el líder— y no impide desafiarlo (`canChallenge` solo mira `lesionado` / desafío
activo).

### Pendiente conocido, no implementado

Registrar en `ranking_log` cada transición lesión/alta del #1, para que el admin detecte ciclos.
Hoy esas transiciones son un UPDATE directo del cliente sobre `players` (`Perfil.jsx`,
`Admin.jsx`), no una RPC: exigiría crear una RPC `SECURITY DEFINER` o abrir un INSERT de cliente
sobre una tabla de auditoría (falsificable). Con el reloj monótono el exploit ya no rinde, así
que no se agregaron cooldowns ni límites de lesiones.

### Hashes

| | hash normalizado |
|---|---|
| antes (030, lo que estaba vigente en prod) | `366f608998acf245d93b0454769cb545` |
| después (031) | `c2319dc9c7376b04d66d5d5c10d8169d` |

### Verificación en TEST antes de aplicar

La suite vive hoy en `db/cutover/test_032_reloj_sin_rivales.mjs` (se renombró al generalizar la
regla en la mig 032; estos escenarios siguen ahí como bloque de regresión). Cuando se aplicó la
031 era `test_031_lider_reloj_condicional.mjs` — 12 escenarios, 24 asserts, todo dentro de una
transacción que termina en `ROLLBACK`. Cubre: #1 sano congelado, reloj sucio congelado sin
auto-lesión, jugar como único reinicio, el ciclo lesión/alta completo, el #1 lesionado cruzando
14/21/28, el nuevo #1 conservando su reloj, la nota de lesión manual sobreviviendo al cron, la
derrota del #1 y la idempotencia diaria. Todos OK.

---

## 5. Remediación de datos — DESCARTADA

`db/cutover/restaurar_reloj_031.sql` proponía reponer los relojes que quedaron en 0 por el
episodio: Gabriel Rubilar +14 días, Felipe Larrain +2.

**Decisión: no se corre.** La regla nueva estrena con el reloj limpio.

El 0 de Gabriel no viene de su comportamiento sino de reparar un error del sistema; reponerle 14
días de inactividad sería hacerle cargar con la consecuencia de un bug nuestro. Desde acá, todo
lo que muestre su reloj es producto de la regla nueva. Felipe queda con su déficit de 2 días:
irrelevante frente a un umbral de 14, y desaparece solo en cuanto juegue.

El script se conserva **solo como registro del análisis** (el cálculo del offset y por qué el
reloj no se puede reconstruir desde `ultima_fecha_jugada` siguen siendo válidos), con un aviso
`DESCARTADO` en la cabecera. ⚠ Sus guardas de idempotencia **no protegen contra correrlo por
error**: buscan el rastro que deja la propia restauración en `ranking_log`, y como nunca se
corrió, ese rastro no existe.

---

## Deploy de front

Merge de `feature/lider-reloj-condicional` → `main` y push a `origin/main`. Vercel deploya
automáticamente desde `main`. Los cambios de UI acompañan a la regla:

- `src/pages/JugadorPerfil.jsx` — estado "congelado (#1 desafiable)" con el valor visible; para el
  #1 lesionado, umbrales normales con la nota de por qué su reloj sí corre.
- `src/pages/Reglamento.jsx` — regla 4 (inactividad), regla 7 (lesiones) y las FAQ correspondientes.
- `src/pages/Ranking.jsx` — comentario que documenta por qué el badge del #1 sano se muestra igual.

## Notas

- No se agendaron crons nuevos: el `v2_cron_diario` (08:00 UTC) ya llama a `cron_diario()`, que se
  reemplazó con `CREATE OR REPLACE`.
- La numeración **029** sigue reservada para los RPCs de saneo.
- `db/sql/030_exencion_lider.sql` se conserva en el repo con una cabecera de "superada por la 031".
  Estuvo vigente en prod y su definición es el punto de partida de la 031 — **no volver a
  aplicarla**.
