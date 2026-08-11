# Aplicado a PRODUCCIÓN — Congelamiento del reloj sin rivales desafiables (mig 032)

**Fecha:** 10/08/2026
**Base:** producción `rnaqvfmuslddeecgscox`
**Aplicado por:** Sebastián, a mano vía el SQL editor del dashboard de Supabase
(regla del proyecto: `apply.mjs` bloquea prod; el SQL de prod nunca se aplica por conexión directa).

**Antecedente directo:** `db/cutover/aplicado_prod_030_031.md` — el incidente del #1 penalizado por
inactividad y las dos iteraciones de diseño que terminaron en la mig 031. Esta migración generaliza
esa regla; conviene leer esa bitácora primero.

---

## 1. El caso que la motivó

La 031 congela el reloj del **#1 sano** porque no puede desafiar a nadie: su inactividad no depende
de él. Pero el mismo problema aparece **un puesto más abajo** apenas el #1 se lesiona:

> El #2 tiene un solo rival hacia arriba, el #1. Un lesionado no puede ser desafiado
> (guarda `cd.lesionado` en `crear_desafio`). Entonces el #2 se queda **sin nadie a quien
> desafiar** — y sin embargo su reloj seguía corriendo y podía penalizarlo a los 14 días.

Y en cascada: con el #1 y el #2 lesionados le pasa al #3, y así hacia abajo. Es exactamente el
error de diseño que originó todo el episodio, replicado en cada posición que quede sin salida.

---

## 2. La regla generalizada

**Se congela el reloj —conserva su valor, no avanza— de todo jugador SANO que no tenga ningún
rival desafiable por encima**, es decir cuando todos los jugadores con posición menor están
lesionados, o no existe ninguno.

- El **#1 sano** de la 031 pasa a ser el caso particular "cero jugadores arriba".
- Los **LESIONADOS nunca se congelan** por esta vía: su reloj corre siempre. Es lo que destraba el
  bloqueo que ellos mismos provocan al volverse indesafiables — el mismo razonamiento de la 031.
- **Congelar es conservar, no borrar.** Lo único que reinicia un reloj a 0 es **jugar**
  (`aplicar_resultado`). El contador es monótono mientras no se juegue, que es la propiedad que
  cerró el exploit del ciclo lesión/alta en la 031.

### Implementación

Un solo cambio de lógica, en la exclusión de `_incr`:

```sql
-  AND ( p.posicion IS DISTINCT FROM 1 OR COALESCE(p.lesionado, false) )
+  AND ( COALESCE(p.lesionado, false)
+        OR p.posicion IS NULL
+        OR EXISTS (SELECT 1 FROM players q
+                    WHERE q.activo AND q.posicion IS NOT NULL
+                      AND q.posicion < p.posicion
+                      AND NOT COALESCE(q.lesionado, false)) )
```

El término `p.posicion IS NULL` no es decorativo: `q.posicion < NULL` es NULL, así que sin él el
`EXISTS` daría falso y un activo sin posición habría quedado excluido de `_incr` por accidente.

Congelar sigue siendo **no ejecutar ningún UPDATE**: la exclusión de `_incr` es toda la
implementación. Sin normalizaciones, sin sentencia one-shot, sin cambios de datos. `_pen` y la
auto-lesión siguen **sin filtros propios** porque ambos dependen de la pertenencia a `_incr`, y esa
es la invariante que sostiene la regla completa: quien está congelado no avanza, y por lo tanto no
puede cruzar un umbral.

Costo: una subconsulta correlacionada por jugador activo — con ~30 jugadores son ~30 EXISTS sobre
una tabla de 30 filas, irrelevante frente al bucle PL/pgSQL del reacomodo. Si el club creciera un
orden de magnitud, la reescritura natural es un `min(posicion) FILTER (WHERE NOT lesionado)`
calculado una sola vez.

### Observabilidad

El retorno cambia `lider_congelado` por **`congelados_sin_rivales`**: cuántos jugadores activos y
sanos no tenían rival desafiable arriba en esa corrida. No se escribe una línea de `ranking_log`
por corrida — congelar es un no-evento diario y spamearía el log. La señal es el contador.

---

## 3. Decisiones de alcance

**(a) "Sin rivales" NO incluye "rivales sanos pero ocupados con un desafío activo".** Exclusión
deliberada: esa situación es transitoria (los desafíos expiran en ~7 días o se juegan), rara vez
alcanza por sí sola para cruzar un umbral, y congelarla incentivaría esperar a que los rivales se
ocupen para congelarse gratis.

**(b) La Wild Card se ignora.** Un jugador con Wild Card disponible podría técnicamente desafiar
fuera de rango, pero no se le va a exigir quemar su única Wild Card del año para evitar un
congelamiento que además lo beneficia. La condición mira solo la elegibilidad normal.

**(c) "Todos los de arriba lesionados" ⇒ "cero rivales por la vía normal".** Se apoya en la mig
028: los elegibles son los N rivales **no lesionados** más cercanos hacia arriba —los lesionados se
saltan sin ocupar cupo—, así que basta un sano en cualquier posición superior, por lejos que esté,
para tener rival. La recíproca es la que usa esta regla. Además `crear_desafio` exige
`cd.posicion < ch.posicion` y rechaza al desafiado lesionado: no hay otra vía normal de escape.

**(d) El freeze global (mig 025/026) queda intacto.** Con un freeze vigente el cron no incrementa a
nadie —tampoco a los lesionados que destraban bloqueos— porque la rama congelada retorna antes.
Es la semántica existente y es la correcta: el freeze es una decisión explícita del admin que pausa
todo parejo.

---

## 4. Hallazgo: el congelado como piso del reacomodo

En la 031 el congelado era siempre el #1 = `arr_id[1]`, y el barrier solo se consulta sobre
`arr_id[idx + 1]` (el de abajo), así que su presencia en `_barrier` era **inerte**. Con la 032 ya
no: un congelado puede estar en cualquier posición y quedar justo debajo de un lesionado que está
bajando. Si ese congelado trae un reloj ≥ 14 entra en `_barrier` y **frena la bajada** — igual que
cualquier otro inactivo, es el floor de siempre ("nadie cae por debajo de otro que también esté
inactivo"). La diferencia es la duración: el reloj del congelado ya no sube ni baja solo, así que el
bloqueo dura hasta que ese jugador juegue o alguien de arriba se recupere.

**Decisión: se deja como está. No se toca ni el barrier ni el floor.**

1. **El escenario es estrecho**: exige un lesionado arriba *y* un congelado con reloj ≥ 14 justo
   abajo. Y ese reloj alto solo pudo acumularse mientras el jugador **sí** tenía rivales
   disponibles — no se lo ganó estando congelado; son días de inactividad que le corresponden.
2. **El bloqueo tiene salida natural**: el congelado está sano y por lo tanto es desafiable desde
   abajo. En cuanto juega, su reloj se va a 0, sale del barrier y el de arriba baja en la corrida
   siguiente. El escenario (c) del test prueba las dos mitades: bloqueado primero, desbloqueado
   después de jugar.
3. **Tocar el barrier alteraría el floor de TODO el ranking**, que es una regla publicada en el
   reglamento. El costo de cambiarla supera al del caso.

Si aparece en la práctica **se reabre con datos**. La vía mínima queda anotada en la cabecera del
SQL: excluir de `_barrier` a los sanos sin rivales desafiables.

---

## 5. Verificación en TEST antes de aplicar

`db/cutover/test_032_reloj_sin_rivales.mjs` — **43 asserts**, todo dentro de una transacción que
termina en `ROLLBACK`. Renombrada desde `test_031_lider_reloj_condicional.mjs`, con los escenarios
de la 031 conservados como bloque de regresión.

**Bloque 1 — mig 032**

| | escenario | resultado |
|---|---|---|
| (m) | el #1 se lesiona → el #2 queda sin rivales | #2 congelado en 3 mientras el #1 corre; al cruzar el 14 el #1 baja 2 y el ex-#2 queda #1 con su 3 intacto |
| (n) | cascada: #1 y #2 lesionados | ambos lesionados corren; el #3 sano congelado; el #4 acumula; `congelados_sin_rivales = 1` |
| (o) | el congelado desafiado desde abajo pierde | baja 1 puesto con el reloj en 0 — nada especial |
| (p) | el #1 se da de alta | el #2 retoma 3 → 4 desde su valor conservado, sin saltos |
| (q) | ciclo lesión/alta del #1, 6 corridas | ningún contador salta ni retrocede; el #2 avanzó exactamente las 3 corridas con el #1 sano |
| (c) | el congelado con reloj ≥ 14 como piso | frena la bajada (`movio: false` con `penalizados: 1`), y se desbloquea en cuanto el congelado juega |

**Bloque 2 — regresión 031**: (a) #1 sano congelado 5 días · (b) reloj sucio congelado en 27 sin
auto-lesión · (l) defiende y gana → 0 · (k) el exploit del ciclo lesión/alta, ganancia 0 días ·
(d) el nuevo #1 conserva su valor · (e) umbrales 21 y 28 · (j) la nota de lesión manual intacta ·
(h) pierde y baja con 0 · (i) idempotencia diaria. Todos OK.

---

## 6. Hashes

Fórmula normalizada del proyecto (los applies por dashboard convierten LF a CRLF, así que el md5
crudo no calza entre test y prod):

```sql
SELECT md5(replace(pg_get_functiondef('public.cron_diario()'::regprocedure), chr(13), ''));
```

| | hash normalizado |
|---|---|
| antes (031, lo que estaba vigente) | `c2319dc9c7376b04d66d5d5c10d8169d` ✅ verificado en prod antes de aplicar |
| después (032) | `86050a3ccb96b7a65b33e61d9800f03f` ✅ verificado en prod después |

---

## Deploy de front

Merge de `feature/reloj-sin-rivales` → `main` y push a `origin/main`. Vercel deploya automáticamente
desde `main`.

- `src/pages/JugadorPerfil.jsx` — estado `congelado (sin rivales disponibles)`, con
  `congelado (#1 desafiable)` conservado para el caso del #1 porque es más claro. Se agregó una
  query liviana (`posicion, lesionado` de los activos) al `Promise.all` existente para calcular la
  condición en el front. Para un lesionado que bloquea, nota explicando por qué su reloj sí corre.
- `src/pages/Reglamento.jsx` — regla 4 reformulada en torno a "sin rivales disponibles", regla 7
  generalizada (el reloj de un lesionado corre siempre) y las dos FAQ correspondientes.
- `src/pages/Ranking.jsx` — comentario del badge actualizado a la regla general.

## Notas

- No se agendaron crons nuevos: el `v2_cron_diario` (08:00 UTC) ya llama a `cron_diario()`, que se
  reemplazó con `CREATE OR REPLACE`.
- Sin cambios de datos: congelar no requiere tocar ninguna fila, así que la migración no lleva
  sentencia one-shot ni script de remediación.
- La numeración **029** sigue reservada para los RPCs de saneo.
