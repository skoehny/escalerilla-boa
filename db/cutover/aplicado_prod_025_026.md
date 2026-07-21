# Aplicado a PRODUCCIÓN — Congelamiento del reloj (mig 025 + 026)

**Fecha:** 20/07/2026
**Base:** producción `rnaqvfmuslddeecgscox`
**Aplicado por:** Sebastián, a mano vía el SQL editor del dashboard de Supabase
(regla del proyecto: apply.mjs bloquea prod; el SQL de prod nunca se aplica por conexión directa).

## Qué se aplicó (en este orden)

1. `db/sql/025_congelamiento_global.sql`
   - Tabla `reloj_freeze_log` + índice único parcial `uniq_reloj_freeze_activo` (máx. 1 freeze vigente).
   - RLS + GRANT SELECT a `anon, authenticated`.
   - RPCs (SECURITY DEFINER, GRANT EXECUTE a anon/authenticated): `reloj_esta_congelado()`,
     `congelar_reloj_global(text,text)`, `descongelar_reloj_global(text)`.
   - `cron_diario()` con guard de congelamiento global.

2. `db/sql/026_aplazamiento_incremental.sql`
   - Reemplaza `cron_diario()`: rama congelada = aplazar `challenges.deadline` +1/día (con log),
     sin sumar inactividad ni expirar; guard de idempotencia diaria.
   - Reemplaza `descongelar_reloj_global(text)`: ya NO extiende deadlines al descongelar
     (la extensión ocurre día a día); solo cierra el freeze y reporta `dias_congelados` informativo.

> Orden importante: la 026 hace `CREATE OR REPLACE` de `cron_diario` y `descongelar_reloj_global`
> creadas por la 025. Aplicar 025 → 026 deja el diseño incremental final.

## Verificación obtenida (post-aplicación)

```sql
SELECT reloj_esta_congelado() AS congelado,
       (SELECT count(*) FROM reloj_freeze_log) AS freezes;
```

Resultado: **`congelado = false`**, **`freezes = 0`** ✅

## Deploy de front

- Merge (no-squash, fast-forward) de `feature/congelamiento-reloj` → `main` y push a `origin/main`.
- **Commit de main deployado:** `9a740a4` (feat(reloj): avisos WA de congelamiento + indicador de aplazamiento).
- Vercel deploya automáticamente desde `main`.

## Notas

- No se agendaron crons nuevos: el `v2_cron_diario` (08:00 UTC) existente ya respeta el freeze
  automáticamente al haberse reemplazado `cron_diario()`.
- La app usa siempre rol `anon` (PIN auth propio) → por eso los GRANT a `anon` son imprescindibles.
