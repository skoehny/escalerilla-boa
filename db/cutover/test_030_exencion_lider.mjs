// Test de la mig 030 (exención del #1). Corre TODO dentro de una transacción
// que termina en ROLLBACK: no deja rastro en la base de test.
import { readFileSync } from 'fs'
import { Client } from 'pg'

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const url = process.env.DATABASE_URL
if (url.includes('rnaqvfmuslddeecgscox')) { console.error('PRODUCCION. Abortando.'); process.exit(1) }

const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await c.connect()
const q = async (sql, p) => (await c.query(sql, p)).rows
const top = async (nn = 5) => q(
  `select posicion, nombre||' '||apellido as jugador, dias_inactivo d, semanas_inactivo s, lesionado les
     from players where activo and posicion is not null order by posicion limit $1`, [nn])
// Simula "pasó un día": retrocede el sello de idempotencia y corre el cron.
const correrCron = async () => {
  await q(`update v2_config set last_cron_daily_date = (now() at time zone 'UTC')::date - 1 where id=1`)
  return (await q('select cron_diario() r'))[0].r
}

try {
  await q('begin')
  // Sin desafíos vigentes: si no, la pausa por desafío tapa lo que queremos medir.
  await q(`update challenges set status='expired' where status in ('pending','accepted')`)

  console.log('\n=== ESTADO INICIAL ===');            console.table(await top())

  console.log('\n=== TEST 1: una corrida — el #1 no suma, el resto sí ===')
  const r1 = await correrCron()
  console.log('cron:', JSON.stringify({ penalizados: r1.penalizados, lider_exento: r1.lider_exento, movio: r1.movio }))
  console.table(await top())

  console.log('\n=== TEST 2: 20 corridas seguidas — el #1 nunca baja ni acumula ===')
  const lider0 = (await q(`select id, nombre||' '||apellido j from players where activo and posicion=1`))[0]
  for (let i = 0; i < 20; i++) await correrCron()
  const lider1 = (await q(`select posicion, nombre||' '||apellido j, dias_inactivo d, semanas_inactivo s, lesionado les
                             from players where id=$1`, [lider0.id]))[0]
  console.log(`líder inicial: ${lider0.j}`)
  console.log('líder tras 20 días:', JSON.stringify(lider1))
  console.log(lider1.posicion === 1 && lider1.d === 0 && lider1.s === 0 && !lider1.les
    ? 'OK: sigue #1, reloj en 0, sin insignia' : 'FALLA')
  console.table(await top(6))
  console.log('penalizaciones al líder en el log:',
    (await q(`select count(*) n from ranking_log where player_id=$1 and causa='inactividad'
                and detalle='penalización por inactividad'`, [lider0.id]))[0].n)

  console.log('\n=== TEST 3: un jugador con reloj sucio llega al #1 ===')
  const sucio = (await q(`select id, nombre||' '||apellido j, dias_inactivo d from players
                           where activo and posicion between 2 and 8 and dias_inactivo > 20
                           order by dias_inactivo desc limit 1`))[0]
  console.log(`sube al #1: ${sucio.j} (dias_inactivo=${sucio.d})`)
  await q(`select admin_ajustar_posicion($1, 1, 'test')`, [sucio.id])
  console.log('antes del cron:', JSON.stringify((await q(
    `select posicion, dias_inactivo d, semanas_inactivo s from players where id=$1`, [sucio.id]))[0]))
  await correrCron()
  const tras = (await q(`select posicion, dias_inactivo d, semanas_inactivo s, lesionado les from players where id=$1`, [sucio.id]))[0]
  console.log('tras el cron: ', JSON.stringify(tras))
  console.log(tras.d === 0 && tras.s === 0 ? 'OK: reloj normalizado al llegar al #1' : 'FALLA')

  console.log('\n=== TEST 4: el #1 baja por derrota → parte con reloj limpio ===')
  const lider = (await q(`select id, nombre||' '||apellido j from players where activo and posicion=1`))[0]
  const retador = (await q(`select id, nombre||' '||apellido j from players where activo and posicion=3`))[0]
  const ch = (await q(
    `insert into challenges (challenger_id, challenged_id, status, ganador, score_a, score_b, deadline)
     values ($1,$2,'completed','challenger',9,3,current_date+7) returning id`, [retador.id, lider.id]))[0]
  await q(`select aplicar_resultado($1)`, [ch.id])
  const exLider = (await q(`select posicion, dias_inactivo d, semanas_inactivo s from players where id=$1`, [lider.id]))[0]
  console.log(`${retador.j} le gana a ${lider.j} (#1)`)
  console.log('ex-líder:', JSON.stringify(exLider), exLider.d === 0 ? '→ OK: reloj limpio al bajar' : '→ FALLA')
  console.log('nuevo #1:', JSON.stringify((await q(
    `select nombre||' '||apellido j, dias_inactivo d from players where activo and posicion=1`))[0]))
  // Y desde acá el ex-líder SÍ vuelve a acumular. Ojo: la corrida del MISMO día
  // no lo toca porque acaba de jugar (filtro ultima_fecha_jugada < hoy, prexistente).
  await correrCron()
  const mismoDia = (await q(`select dias_inactivo d from players where id=$1`, [lider.id]))[0].d
  await q(`update players set ultima_fecha_jugada = now() - interval '1 day' where id=$1`, [lider.id])
  await correrCron()
  const diaSgte = (await q(`select posicion, dias_inactivo d from players where id=$1`, [lider.id]))[0]
  console.log(`ex-líder el mismo día que jugó: d=${mismoDia} (0 esperado: jugó hoy)`)
  console.log('ex-líder al día siguiente:', JSON.stringify(diaSgte),
    diaSgte.d === 1 ? '→ OK: vuelve a acumular fuera del #1' : '→ FALLA')

  console.log('\n=== TEST 5: la insignia de lesionado MANUAL sobrevive al #1 ===')
  const n1 = (await q(`select id from players where activo and posicion=1`))[0]
  await q(`update players set lesionado=true, lesion_nota='Tendinitis', lesion_fecha=now(),
                  dias_inactivo=30, semanas_inactivo=4 where id=$1`, [n1.id])
  await correrCron()
  const t6 = (await q(`select dias_inactivo d, lesionado les, lesion_nota nota from players where id=$1`, [n1.id]))[0]
  console.log(JSON.stringify(t6), t6.d === 0 && t6.les === true && t6.nota === 'Tendinitis'
    ? '→ OK: reloj en 0 pero la lesión real se mantiene' : '→ FALLA')

  console.log('\n=== TEST 6: idempotencia diaria intacta ===')
  console.log(JSON.stringify(await q('select cron_diario() r').then(r => r[0].r)))
} finally {
  await q('rollback')
  await c.end()
  console.log('\n(rollback: la base de test quedó como estaba)')
}
