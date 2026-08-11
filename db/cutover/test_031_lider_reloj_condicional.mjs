// Test de la mig 031: el reloj del #1 se CONGELA mientras esté sano (desafiable) y
// corre desde ese mismo valor si se lesiona. Congelar no es borrar: el contador es
// monótono, así que el ciclo lesión/alta ya no permite esquivar el umbral 14.
// Corre TODO dentro de una transacción que termina en ROLLBACK: no deja rastro
// en la base de test.
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
const one = async (sql, p) => (await q(sql, p))[0]
const top = async (nn = 6) => q(
  `select posicion, nombre||' '||apellido as jugador, dias_inactivo d, semanas_inactivo s,
          lesionado les, coalesce(lesion_nota,'') nota
     from players where activo and posicion is not null order by posicion limit $1`, [nn])
const ficha = (id) => one(
  `select posicion pos, nombre||' '||apellido j, dias_inactivo d, semanas_inactivo s,
          lesionado les, coalesce(lesion_nota,'') nota from players where id=$1`, [id])
const lider = () => one(
  `select id, posicion pos, nombre||' '||apellido j, dias_inactivo d, lesionado les
     from players where activo and posicion=1`)
// Simula "pasó un día": retrocede el sello de idempotencia y corre el cron.
const correrCron = async () => {
  await q(`update v2_config set last_cron_daily_date = (now() at time zone 'UTC')::date - 1 where id=1`)
  return (await one('select cron_diario() r')).r
}
// Deja el resto del ranking con el reloj limpio, para que el barrier/floor no
// tape los movimientos que estamos midiendo.
const limpiarResto = (ids) => q(
  `update players set dias_inactivo=0, semanas_inactivo=0 where activo and not (id = any($1))`, [ids])
// Dentro de una transacción todas las filas comparten created_at (es el timestamp
// de la transacción), así que no se puede ordenar por fecha: se cuenta.
const contarLog = async (id, detalle) => (await one(
  `select count(*)::int n from ranking_log where player_id=$1 and detalle=$2`, [id, detalle])).n
// Alta / lesión tal como las hace src/pages/Perfil.jsx (update directo, sin RPC).
const lesionar = (id, nota) => q(
  `update players set lesionado=true, lesion_nota=$2, lesion_fecha=now() where id=$1`, [id, nota])
const darDeAlta = (id) => q(`update players set lesionado=false, lesion_nota='' where id=$1`, [id])
let fallas = 0
const ok = (cond, msg) => { if (!cond) fallas++; console.log(`${cond ? 'OK  ' : 'FALLA'} — ${msg}`) }

try {
  await q('begin')

  // ── Preparación ────────────────────────────────────────────────────────
  await q(`update challenges set status='expired' where status in ('pending','accepted')`)
  await q(`update players set dias_inactivo=0, semanas_inactivo=0, inactividad_congelada=false,
                  lesionado = case when lesion_nota='Inactividad (4 semanas)' then false else lesionado end,
                  lesion_nota = case when lesion_nota='Inactividad (4 semanas)' then '' else lesion_nota end
            where activo`)

  const L0 = await lider()
  const control = await one(`select id, nombre||' '||apellido j from players where activo and posicion=4`)
  console.log(`líder: ${L0.j} (#1)   ·   control: ${control.j} (#4)`)
  console.log('\n=== ESTADO INICIAL ==='); console.table(await top())

  // ── (a) el #1 sano no acumula; el resto sí ─────────────────────────────
  console.log('\n=== (a) #1 sano congelado durante 5 corridas ===')
  let r
  for (let i = 0; i < 5; i++) r = await correrCron()
  const La = await ficha(L0.id), Ca = await ficha(control.id)
  console.log('líder  :', JSON.stringify(La))
  console.log('control:', JSON.stringify(Ca))
  ok(La.d === 0 && La.pos === 1, 'el #1 sano sigue en 0 tras 5 días')
  ok(Ca.d === 5, 'el control acumuló los 5 días')
  ok(r.lider_congelado === 1, 'el cron reporta que hubo un #1 sano congelado')

  // ── (b) #1 sano con reloj sucio → SE CONGELA, no se borra ──────────────
  console.log('\n=== (b) #1 sano con reloj sucio (ajuste de admin a 27) ===')
  await q(`select admin_ajustar_reloj($1, 27, 'test: reloj sucio')`, [L0.id])
  const rb1 = await correrCron()
  const rb2 = await correrCron()
  const Lb = await ficha(L0.id)
  console.log('tras 2 corridas:', JSON.stringify(Lb),
    '· cron:', JSON.stringify({ lider_congelado: rb2.lider_congelado, penalizados: rb2.penalizados, lesionados_nuevos: rb2.lesionados_nuevos }))
  ok(Lb.d === 27, 'el reloj queda CONGELADO en 27 (no se normaliza a 0)')
  ok(Lb.s === 3, 'semanas_inactivo sigue consistente con floor(27/7)')
  ok(Lb.les === false && Lb.pos === 1, 'no lo alcanza ni la auto-lesión ni la penalización (no está en _incr)')
  ok(rb1.penalizados === 0 && rb2.penalizados === 0, 'ninguna de las dos corridas lo penalizó')

  // ── (l) el #1 congelado defiende y gana → aplicar_resultado lo reinicia ─
  console.log('\n=== (l) el #1 congelado en 27 defiende un desafío y gana ===')
  const retadorL = await one(`select id, nombre||' '||apellido j from players where activo and posicion=3`)
  const chL = await one(
    `insert into challenges (challenger_id, challenged_id, status, ganador, score_a, score_b, deadline)
     values ($1,$2,'completed','challenged',3,9,current_date+7) returning id`, [retadorL.id, L0.id])
  await q(`select aplicar_resultado($1)`, [chL.id])
  const Ll = await ficha(L0.id)
  console.log(`${L0.j} (#1) le gana a ${retadorL.j} → ${JSON.stringify(Ll)}`)
  ok(Ll.d === 0 && Ll.s === 0 && Ll.pos === 1, 'jugar es lo único que reinicia el reloj del #1: 27 → 0')
  await q(`update players set ultima_fecha_jugada = now() - interval '1 day'
            where id = any($1)`, [[L0.id, retadorL.id]])

  // ── (k) EXPLOIT: ciclo lesión → alta → lesión ─────────────────────────
  console.log('\n=== (k) el ciclo lesión/alta ya no borra el reloj ===')
  await lesionar(L0.id, 'Tendinitis')
  for (let i = 0; i < 13; i++) { await limpiarResto([L0.id]); await correrCron() }
  const Lk1 = await ficha(L0.id)
  console.log('tras 13 días lesionado:', JSON.stringify(Lk1))
  ok(Lk1.d === 13 && Lk1.pos === 1, 'el reloj del #1 lesionado llegó a 13 sin cruzar umbral')

  // Alta justo antes del umbral: el movimiento del exploit.
  await darDeAlta(L0.id)
  await limpiarResto([L0.id])
  const rk = await correrCron()
  const Lk2 = await ficha(L0.id)
  console.log('tras darse de alta y correr 1 día:', JSON.stringify(Lk2),
    '· cron:', JSON.stringify({ lider_congelado: rk.lider_congelado, penalizados: rk.penalizados }))
  ok(Lk2.d === 13, 'el alta NO borra el reloj: sigue en 13 (antes se iba a 0 → exploit)')
  ok(rk.lider_congelado === 1 && rk.penalizados === 0, 'ese día está sano: congelado y desafiable, sin penalización')
  console.log(`>> ganancia del ciclo: ${Lk2.d - Lk1.d} días de reloj (el costo es 1 día desafiable)`)

  // Se lesiona de nuevo: el reloj continúa desde 13 y cruza el umbral.
  await lesionar(L0.id, 'Tendinitis')
  await limpiarResto([L0.id])
  const penAntes = await contarLog(L0.id, 'penalización por inactividad')
  const rk2 = await correrCron()
  const Lk3 = await ficha(L0.id)
  const nuevo = await lider()
  console.log('tras volver a lesionarse y correr 1 día:', JSON.stringify(Lk3),
    '· cron:', JSON.stringify({ penalizados: rk2.penalizados, lider_congelado: rk2.lider_congelado }))
  console.table(await top(4))
  ok(Lk3.d === 14, 'el reloj continúa desde 13 y cruza el 14')
  ok(Lk3.pos === 3, `baja 2 puestos (1 → ${Lk3.pos}): el ciclo no lo salvó`)
  ok(rk2.lider_congelado === 0, 'ese día el #1 estaba lesionado: sin congelamiento')
  ok(await contarLog(L0.id, 'penalización por inactividad') === penAntes + 1,
     'queda registrada como penalización normal')
  ok((await one(`select count(*)::int n from ranking_log
                  where player_id=$1 and detalle='penalización por inactividad' and desde=1`, [L0.id])).n === 1,
     'la penalización quedó registrada como "desde la #1"')
  ok(nuevo.les === false && nuevo.pos === 1, `el nuevo #1 (${nuevo.j}) está sano y es desafiable`)

  // ── (d) el nuevo #1 sano queda congelado, no en 0 ──────────────────────
  console.log('\n=== (d) el nuevo #1 sano conserva su reloj ===')
  const Nd0 = await ficha(nuevo.id)
  await correrCron(); await correrCron()
  const Nd = await ficha(nuevo.id)
  console.log(`al subir: d=${Nd0.d} · tras 2 corridas: ${JSON.stringify(Nd)}`)
  ok(Nd.d === Nd0.d && Nd.pos === 1, 'no avanza ni se borra: queda congelado en el valor que traía')

  // ── (e) el ex-#1 lesionado sigue el régimen normal ─────────────────────
  console.log('\n=== (e) el ex-#1 lesionado sigue con 21 y 28 ===')
  for (const [previo, umbral] of [[20, 21], [27, 28]]) {
    await q(`update players set dias_inactivo=$2::int, semanas_inactivo=floor($2::int/7.0)::int where id=$1`,
            [L0.id, previo])
    await limpiarResto([L0.id])
    const pos0 = (await ficha(L0.id)).pos
    const re = await correrCron()
    const Le = await ficha(L0.id)
    console.log(`umbral ${umbral}: #${pos0} → ${JSON.stringify(Le)} · cron: ${JSON.stringify({ penalizados: re.penalizados, lesionados_nuevos: re.lesionados_nuevos })}`)
    ok(Le.d === umbral && Le.pos === pos0 + 1, `a los ${umbral} días baja 1 puesto más`)
  }

  // ── (j) la nota de lesión manual nunca es pisada por el cron ───────────
  console.log('\n=== (j) la lesión manual sobrevive a los 28 días ===')
  const Lj = await ficha(L0.id)
  console.log(JSON.stringify(Lj))
  ok(Lj.les === true && Lj.nota === 'Tendinitis',
     'cruzó los 28 días y el cron no reemplazó la nota "Tendinitis"')

  // ── (h) el #1 baja por derrota → reloj 0 y régimen normal ──────────────
  console.log('\n=== (h) el #1 pierde un desafío ===')
  const l1 = await lider()
  const retador = await one(`select id, nombre||' '||apellido j from players where activo and posicion=2`)
  const ch = await one(
    `insert into challenges (challenger_id, challenged_id, status, ganador, score_a, score_b, deadline)
     values ($1,$2,'completed','challenger',9,3,current_date+7) returning id`, [retador.id, l1.id])
  await q(`select aplicar_resultado($1)`, [ch.id])
  const exL = await ficha(l1.id)
  console.log(`${retador.j} le gana al #1 ${l1.j} → ex-líder: ${JSON.stringify(exL)}`)
  ok(exL.pos === 2 && exL.d === 0, 'el ex-líder bajó a la #2 con el reloj en 0')
  await q(`update players set ultima_fecha_jugada = now() - interval '1 day' where id=$1`, [l1.id])
  await correrCron()
  ok((await ficha(l1.id)).d === 1, 'al día siguiente el ex-líder acumula normal')

  // ── (i) idempotencia diaria ───────────────────────────────────────────
  console.log('\n=== (i) idempotencia diaria ===')
  const antesIdem = await top(4)
  const ri = (await one('select cron_diario() r')).r
  console.log(JSON.stringify(ri))
  ok(ri.skipped === 'ya_corrio_hoy', 'la segunda corrida del día no hace nada')
  ok(JSON.stringify(antesIdem) === JSON.stringify(await top(4)), 'el ranking quedó idéntico')

  console.log('\n=== ESTADO FINAL ==='); console.table(await top(8))
  console.log(fallas === 0 ? '\n>>> TODOS LOS ESCENARIOS OK' : `\n>>> ${fallas} FALLA(S)`)
} finally {
  await q('rollback')
  await c.end()
  console.log('\n(rollback: la base de test quedó como estaba)')
}
