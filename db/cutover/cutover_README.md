# Cutover a producción — Escalerilla v2 "Ranking en Vivo"

Runbook para el estreno en la base **PROD** (`rnaqvfmuslddeecgscox`). Todo se
ejecuta **a mano en el SQL editor del dashboard de Supabase de prod**. Los scripts
de este repo (`db/apply.mjs`) **bloquean prod por diseño** — no se usan aquí.

**Regla de oro:** el **merge a `main` es el ÚLTIMO paso**, solo después de verificar
la base. Mientras no se mergee, el frontend **v1 sigue operando** contra el esquema
nuevo sin problemas (ver §"Seguridad v1" abajo).

Archivos (ejecutar en este orden):

| Orden | Archivo | Qué hace |
|---|---|---|
| — | `cutover_03` **FASE 0** | Pre-flight: confirma esquema base preexistente |
| 0 | `cutover_00_prereqs.sql` | 2 funciones NO versionadas (idempotentes) |
| 0b | `cutover_00b_prod_base.sql` | **Base que falta en PROD**: v2_config + 3 columnas + trigger |
| 1 | `cutover_01_migraciones.sql` | Migraciones 010–024 + agenda los 3 crons |
| 2 | `cutover_02_inicializacion.sql` | Config + saneo + wildcard + estreno de foto |
| ✓ | `cutover_03_verificacion.sql` | SELECTs de verificación por fase |

---

## ⚠ Seguridad v1: ¿alguna migración rompe la app vieja antes del deploy?

**No.** Verificado contra el código de `main` y contra las 14 migraciones:

- **RPCs que llama v1:** `hash_pin`, `publish_ranking`, `register_player`,
  `solicitar_reset_pin`, `undo_ranking`, `verify_pin`. **Ninguna** es modificada
  por 010–024 (esas migraciones solo tocan funciones v2: `crear_desafio`,
  `aplicar_resultado`, `marcar_wo`, etc., que v1 no invoca).
- **Escrituras directas de v1** (`players`/`challenges` insert/update): todas las
  columnas nuevas se agregan con `ADD COLUMN IF NOT EXISTS` y son **nullable** o
  **`NOT NULL DEFAULT`** — los `INSERT`/`UPDATE` de v1 (que las omiten) siguen
  siendo válidos.
- **Sin** `ALTER COLUMN`, **sin** constraints nuevos sobre columnas existentes,
  **sin** triggers nuevos, **sin** `DROP` de columnas (los únicos `DROP` son de
  tablas temporales dentro de funciones).
- El único `DROP FUNCTION` (mig 021, firma vieja de `corregir_resultado`) es de una
  función v2 que v1 no llama.

Conclusión: durante toda la Fase 1 (base migrada, frontend v1 aún desplegado) la
app vieja funciona igual. Recién en la Fase 2 se mergea `main`.

## 🛑 Gaps detectados en PROD (por eso existen `cutover_00` y `cutover_00b`)

El respaldo de prod (2026-07-16) mostró que su esquema **no coincide** con el de
prueba. Hay que cerrar dos grupos de faltantes ANTES de `cutover_01`:

**Funciones no versionadas — `cutover_00_prereqs.sql`:**
- **`recalcular_stats()`** — la llama `aplicar_resultado`. *(Prod YA la tiene; el
  `CREATE OR REPLACE` es inocuo.)*
- **`aplicar_pendientes()`** — la ejecuta el cron `v2_aplicar_pendientes` (*/5).
  **Prod NO la tiene** → sin ella ese cron falla cada 5 min.

**Base de esquema que falta en PROD — `cutover_00b_prod_base.sql`** (idempotente):
- **Tabla `v2_config` inexistente.** Todas las migraciones 011+ la ALTERan y
  `UPDATE … WHERE id=1`. Sin ella, **el cutover muere en la migración 011**. `00b`
  la crea con las columnas base + fila `id=1` (ventana=90, fechas en NULL;
  `cutover_02` fija la config definitiva: ventana=1440, etc.).
- **`challenges` sin `disputado`, `resultado_ingresado_at`, `disputa_motivo`**
  (columnas pre-010 que ninguna migración crea; las usan `aplicar_pendientes` y el
  trigger). `00b` las agrega.
- **Sin trigger `trg_stamp_resultado`** ni su función `stamp_resultado_ingresado()`
  (prod tiene 0 triggers). Sin él, `resultado_ingresado_at` nunca se estampa → se
  rompen la ventana de corrección y el cron de pendientes. `00b` los crea.

Ya presente y OK en prod: `players` con todas las columnas base; `weekly_config`
(semana, fechas, publicado_manual); `ranking_history` con índice único en `semana`.

**La FASE 0 del pre-flight detecta exactamente estos faltantes** (0.1 la tabla
`v2_config`, 0.2 las 3 columnas de challenges, 0.3 el trigger).

---

## FASE 0 — Respaldo y pre-flight (ANTES de tocar nada)

1. **Respaldo.**
   - Dashboard → **Database → Backups**: confirmá que hay un backup reciente (o
     dispará uno / apuntá el PITR).
   - **Además, `pg_dump` manual** a un archivo local (respaldo lógico que podés
     restaurar selectivamente):
     ```bash
     pg_dump "postgresql://postgres:[PASS]@db.rnaqvfmuslddeecgscox.supabase.co:5432/postgres" \
       --no-owner --format=custom -f backup_prod_precutover.dump
     ```
2. **pg_cron habilitado.** Dashboard → **Database → Extensions** → activar
   **`pg_cron`** (si no está). `cutover_01` hace `CREATE EXTENSION IF NOT EXISTS
   pg_cron`, pero en Supabase suele requerir el toggle del dashboard primero.
3. **Pre-flight.** Ejecutar la **FASE 0** de `cutover_03_verificacion.sql`
   (secciones 0.1–0.5). Según el respaldo de prod, esperá esto ANTES de `00b/01`:
   - 0.1: `challenges`, `players`, `weekly_config`, `ranking_history` `ok`;
     **`v2_config` FALTA** (la crea `00b`) y `ranking_log` FALTA (la crea la 016).
   - 0.2: la mayoría `ok`, pero **`challenges.disputado`, `resultado_ingresado_at`
     y `disputa_motivo` FALTA**, y las 3 de `v2_config` (tabla ausente). Las crea `00b`.
     Si falta CUALQUIER OTRA columna de las listadas → **DETENER** (esquema pre-010
     realmente incompleto, fuera de lo que `00b` cubre).
   - 0.3: `trg_stamp_resultado` devuelve **0 filas** (prod tiene 0 triggers). Lo crea `00b`.
   - 0.4: `weekly_config` con `id=1` (=1). `v2_config` dará 0 hasta correr `00b`.
   - 0.5: índice único `ranking_history(semana)` presente (1 fila; lo usa `foto_jueves`).

   > Los faltantes de 0.1/0.2/0.3 son **esperados** y los cierra `cutover_00b`. Solo
   > DETENÉ si aparece un faltante FUERA de esa lista conocida.

> Si la FASE 0 pasa, seguí. Si algo crítico falta, parás acá: el frontend v1 sigue
> vivo y no tocaste nada.

---

## FASE 1 — Migrar la base (frontend v1 sigue desplegado)

4. **`cutover_00_prereqs.sql`.** Ejecutar entero. Si `recalcular_stats` falla al
   crearse con *"column ... does not exist"*, es la misma señal que 0.2 → DETENER.
5. **`cutover_00b_prod_base.sql`.** Ejecutar entero. Crea `v2_config`+fila `id=1`,
   las 3 columnas de `challenges` y el trigger `trg_stamp_resultado`. Idempotente:
   si algo ya existía, no lo pisa (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`).
   Verificá con una re-corrida de FASE 0: ahora 0.1 `v2_config` `ok`, 0.2 las 3
   columnas `ok`, 0.3 el trigger 1 fila.
6. **`cutover_01_migraciones.sql`.** Ejecutar entero (010→024). Crea columnas,
   funciones, `ranking_log`, la extensión `pg_cron` y **agenda los 3 crons**.
7. **`cutover_02_inicializacion.sql` pasos (a)–(d).**
   - **(a) PRIMERO y sin demora tras la 01**: fija `last_foto_jueves_date = hoy`
     (guard: el cron de las 16:00 UTC se salta mientras trabajás). ⏱ Ver §Foto.
   - (b) config definitiva; (c) descongelar + revisar el diagnóstico de fechas
     nulas (sanear si aparecen filas, según el comentario); (d) consultar/agendar
     el cron anual de wildcard.
   - **NO ejecutes el paso (e) todavía.**
8. **Verificar FASE A y FASE B** de `cutover_03`:
   - A.1: las **18 funciones** `ok`. A.2: `corregir_resultado` y `marcar_wo` con
     **1 firma** cada una (sin overload). A.3: columnas nuevas `ok`. A.4: los 3
     crons `v2_*` activos (+ `yearly-wildcard-reset` si lo agendaste).
   - B.1: config = `1440 / 7 / 24 / 4 / set9 / Club BOA / hoy / NULL / hoy`.
     B.2: `duplicados=0`, `sin_huecos=true`. B.3: `congelados=0`.

---

## FASE — La foto del jueves (estreno)

Hoy es **jueves**; el cron `v2_foto_jueves` corre a **16:00 UTC**. Dos escenarios:

- **Terminás la FASE 1 ANTES de las 16:00 UTC:** el guard (a) ya dejó
  `last_foto_jueves_date = hoy`, así que el cron de las 16:00 **se salta**. Cuando
  todo esté verificado, ejecutá el **paso (e)** de `cutover_02` para el estreno manual:
  ```sql
  UPDATE v2_config SET last_foto_jueves_date = NULL WHERE id = 1;
  SELECT foto_jueves();
  ```
- **Terminás DESPUÉS de las 16:00 UTC** y preferís que dispare el cron: **no**
  corras el paso (e); en su lugar dejá `last_foto_jueves_date` en un valor
  distinto de hoy (`UPDATE v2_config SET last_foto_jueves_date = NULL WHERE id=1;`)
  y esperá al próximo tick — pero como el cron ya pasó a las 16:00, para el estreno
  de HOY conviene el disparo **manual** (paso e). Recomendado: **paso (e) manual**
  en cualquier caso, es determinístico.

Verificar **FASE C** de `cutover_03`: C.1 muestra la foto nueva
(`publicado_por='auto'`, semana +1, jugadores = nº de activos). C.2:
`last_foto_jueves_date = hoy` (foto_jueves lo re-sella).

> **NO** habrá publicación manual v1 hoy: la foto **es** la publicación.

---

## FASE 2 — Frontend (ÚLTIMO, solo tras verificar la base)

9. **Env vars de Vercel.** Confirmá que el proyecto apunta a la URL/anon key de
   **prod** (`rnaqvfmuslddeecgscox`), no a prueba.
10. **Merge y deploy.** `v2-ranking-live` → `main`, push. Vercel despliega.
    ```bash
    git checkout main && git merge v2-ranking-live && git push origin main
    ```
11. **Smoke test** en la URL de prod:
    - Login con PIN (jugador y admin).
    - Ranking carga y ordena por posición.
    - Crear un desafío de prueba y **expirarlo/cancelarlo** (o marcarlo WO) para no
      ensuciar el ranking real; verificar que las reglas responden.
    - Branding: título "Escalerilla", pelota verde, nombre de club "Club BOA".
    - PWA: favicon/manifest, instalable.

---

## ROLLBACK (si algo sale mal a mitad de camino)

- **Durante FASE 0/1 (antes del merge):** el frontend v1 sigue apuntando al mismo
  esquema y **sigue funcionando**. Si querés revertir la base:
  - Restaurá el respaldo (Dashboard → Backups / PITR, o `pg_restore` del
    `.dump`).
  - Los crons quedan agendados aunque falle algo: para desactivarlos sin restaurar,
    `SELECT cron.unschedule('v2_aplicar_pendientes');` (idem `v2_cron_diario`,
    `v2_foto_jueves`).
  - Como **no se mergeó `main`**, no hay que revertir ningún deploy: la app vieja
    nunca dejó de operar.
- **Después del merge (FASE 2):** si el frontend nuevo falla, revertí el deploy en
  Vercel (redeploy del commit anterior de `main`) o `git revert` del merge + push.
  La base migrada es compatible con v1, así que el rollback de frontend es seguro.

---

### Apéndice — limpieza opcional (post-cutover, sin apuro)
- `v2_config.ultima_corrida_inactividad` es un leftover sin uso; se puede dropear
  más adelante: `ALTER TABLE v2_config DROP COLUMN ultima_corrida_inactividad;`
