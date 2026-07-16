#!/usr/bin/env node
// =====================================================================
// backup_prod.mjs — RESPALDO DE PRODUCCIÓN, ESTRICTAMENTE SOLO LECTURA
// =====================================================================
// Conecta a la base de PROD (rnaqvfmuslddeecgscox) para LEER y respaldar.
// - NO lee .env (ese apunta a PRUEBA): la URL llega por env PROD_URL o argv[2].
// - Guard inverso: aborta si la URL NO contiene el id de PROD.
// - Toda la sesión corre en una transacción READ ONLY: el motor rechaza
//   cualquier escritura aunque hubiera un bug.
//
// Uso:
//   PROD_URL="postgresql://...pooler...rnaqvfmuslddeecgscox..." node db/cutover/backup_prod.mjs
//   node db/cutover/backup_prod.mjs "postgresql://...rnaqvfmuslddeecgscox..."
//
// Salida: db/cutover/backup_prod_<YYYY-MM-DD>/
//   - <tabla>.json           (todas las filas de cada tabla de public)
//   - schema_prod.sql        (funciones, triggers, columnas, índices — referencia)
//   - _report.json           (tablas, filas, tamaños)
// =====================================================================
import { Client } from 'pg'
import { mkdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const PROD_ID = 'rnaqvfmuslddeecgscox'
const PRUEBA_ID = 'ivnpebzmehmsyggppubu'

const url = process.env.PROD_URL || process.argv[2]
if (!url) {
  console.error('ERROR: falta la URL de PROD. Pasala por PROD_URL=... o como primer argumento.')
  process.exit(1)
}
// Guard inverso: debe ser PROD, y nunca la base de prueba.
if (!url.includes(PROD_ID)) {
  console.error(`ERROR: la URL no contiene el id de PROD (${PROD_ID}). Abortando por seguridad.`)
  process.exit(1)
}
if (url.includes(PRUEBA_ID)) {
  console.error('ERROR: la URL apunta a la base de PRUEBA. Abortando.')
  process.exit(1)
}

// Carpeta de salida con fecha local (YYYY-MM-DD)
const hoy = new Date().toLocaleDateString('en-CA') // en-CA => YYYY-MM-DD
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, `backup_prod_${hoy}`)
mkdirSync(outDir, { recursive: true })

const sanitize = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await c.connect()

// Sesión de solo lectura a nivel de servidor: bloquea cualquier escritura.
await c.query('BEGIN')
await c.query('SET TRANSACTION READ ONLY')

const report = { prod_id: PROD_ID, fecha: hoy, generado: new Date().toISOString(), tablas: [], totales: {} }

try {
  console.log(`\n== RESPALDO PROD (${PROD_ID}) — SOLO LECTURA ==`)
  console.log(`Salida: ${outDir}\n`)

  // 1) Listar tablas base de public
  const { rows: tablas } = await c.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`)

  // 2) Volcar cada tabla a JSON + contar filas + tamaño
  let totalFilas = 0
  let totalJsonBytes = 0
  for (const { table_name } of tablas) {
    const q = `SELECT * FROM "${table_name}"`
    const { rows } = await c.query(q)
    const json = JSON.stringify(rows, null, 2)
    const file = join(outDir, `${sanitize(table_name)}.json`)
    writeFileSync(file, json)
    const bytes = Buffer.byteLength(json)
    // tamaño físico en disco de la tabla (datos + índices + toast)
    const { rows: sz } = await c.query(
      `SELECT pg_total_relation_size($1) AS bytes, pg_size_pretty(pg_total_relation_size($1)) AS pretty`,
      [table_name])
    totalFilas += rows.length
    totalJsonBytes += bytes
    report.tablas.push({
      tabla: table_name,
      filas: rows.length,
      json_bytes: bytes,
      tamaño_fisico: sz[0].pretty,
      tamaño_fisico_bytes: Number(sz[0].bytes),
    })
    console.log(`  ${table_name.padEnd(24)} ${String(rows.length).padStart(7)} filas   ${sz[0].pretty.padStart(10)}   -> ${sanitize(table_name)}.json`)
  }

  // 3) Schema de referencia (funciones, triggers, columnas, índices)
  let schema = `-- Schema de referencia de PROD (${PROD_ID}) — generado ${new Date().toISOString()}\n`
  schema += `-- SOLO REFERENCIA (no es un dump ejecutable completo). Para restaurar usar el pg_dump/backup del dashboard.\n\n`

  const { rows: cols } = await c.query(`
    SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`)
  schema += `-- ============ COLUMNAS ============\n`
  let lastT = null
  for (const r of cols) {
    if (r.table_name !== lastT) { schema += `\n-- tabla: ${r.table_name}\n`; lastT = r.table_name }
    schema += `--   ${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}${r.column_default ? ' DEFAULT ' + r.column_default : ''}\n`
  }

  const { rows: idx } = await c.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' ORDER BY tablename, indexname`)
  schema += `\n\n-- ============ ÍNDICES ============\n`
  for (const r of idx) schema += `${r.indexdef};\n`

  const { rows: fns } = await c.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY p.proname`)
  schema += `\n\n-- ============ FUNCIONES (${fns.length}) ============\n`
  for (const r of fns) schema += `\n-- función: ${r.proname}\n${r.def};\n`

  const { rows: trg } = await c.query(`
    SELECT c.relname AS tabla, t.tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`)
  schema += `\n\n-- ============ TRIGGERS (${trg.length}) ============\n`
  for (const r of trg) schema += `${r.def};\n`

  writeFileSync(join(outDir, 'schema_prod.sql'), schema)
  report.totales.funciones = fns.length
  report.totales.triggers = trg.length
  report.totales.indices = idx.length

  // 4) Tamaños globales
  const { rows: dbsz } = await c.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database()) AS bytes`)
  report.totales.tablas = tablas.length
  report.totales.filas = totalFilas
  report.totales.json_bytes = totalJsonBytes
  report.totales.db_size = dbsz[0].pretty
  report.totales.db_size_bytes = Number(dbsz[0].bytes)

  writeFileSync(join(outDir, '_report.json'), JSON.stringify(report, null, 2))

  console.log(`\n== RESUMEN ==`)
  console.log(`  Tablas:        ${tablas.length}`)
  console.log(`  Filas totales: ${totalFilas}`)
  console.log(`  Funciones:     ${fns.length}   Triggers: ${trg.length}   Índices: ${idx.length}`)
  console.log(`  JSON exportado: ${(totalJsonBytes / 1024).toFixed(1)} KB`)
  console.log(`  Tamaño DB (físico): ${dbsz[0].pretty}`)
  console.log(`  Carpeta: ${outDir}`)
} catch (e) {
  console.error('\nERROR durante el respaldo:', e.message)
  process.exitCode = 1
} finally {
  await c.query('ROLLBACK') // cierra la transacción de solo lectura sin efectos
  await c.end()
}
