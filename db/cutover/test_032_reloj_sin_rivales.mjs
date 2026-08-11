// Test de la mig 032: el reloj se congela para todo jugador SANO que no tenga
// rivales desafiables por encima (todos los de arriba lesionados, o nadie arriba).
// El #1 sano de la 031 es el caso particular "cero jugadores arriba".
// Incluye la regresión completa de la suite 031 (bloque 2).
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
const enPos = (pos) => one(
  `select id, posicion pos, nombre||' '||apellido j, dias_inactivo d, lesionado les
     from players where activo and posicion=$1`, [pos])
// Simula "pasó un día": retrocede el sello de idempotencia y corre el cron.
const correrCron = async () => {
  await q(`update v2_config set last_cron_daily_date = (now() at time zone 'UTC')::date - 1 where id=1`)
  return (await one('select cron_diario() r')).r
}
// Estado limpio y conocido: sin desafíos vigentes, todos sanos, relojes en 0 y con
// el último partido lo bastante atrás como para que nadie quede fuera del
// incremento por el filtro de "jugó hoy".
const reset = async () => {
  await q(`update challenges set status='expired' where status in ('pending','accepted')`)
  await q(`update players set dias_inactivo=0, semanas_inactivo=0, inactividad_congelada=false,
                  lesionado=false, lesion_nota='', lesion_fecha=null,
                  ultima_fecha_jugada = now() - interval '30 days'
            where activo`)
}
// Deja el resto del ranking con el reloj limpio, para que el barrier/floor no
// tape los movimientos que estamos midiendo.
const limpiarResto = (ids) => q(
  `update players set dias_inactivo=0, semanas_inactivo=0 where activo and not (id = any($1))`, [ids])
// Dentro de una transacción todas las filas comparten created_at (es el timestamp
// de la transacción), así que no se puede ordenar por fecha: se cuenta.
const contarLog = async (id, detalle) => (await one(
  `select count(*)::int n from ranking_log where player_id=$1 and detalle=$2`, [id, detalle])).n
// Lesión / alta tal como las hace src/pages/Perfil.jsx (update directo, sin RPC).
const lesionar = (id, nota) => q(
  `update players set lesionado=true, lesion_nota=$2, lesion_fecha=now() where id=$1`, [id, nota])
const darDeAlta = (id) => q(`update players set lesionado=false, lesion_nota='' where id=$1`, [id])
const setReloj = (id, d) => q(
  `update players set dias_inactivo=$2::int, semanas_inactivo=floor($2::int/7.0)::int where id=$1`, [id, d])
// Partido con resultado ya aplicado: el challenger o el challenged gana.
const jugar = async (challengerId, challengedId, ganador) => {
  const ch = await one(
    `insert into challenges (challenger_id, challenged_id, status, ganador, score_a, score_b, deadline)
     values ($1,$2,'completed',$3,9,3,current_date+7) returning id`, [challengerId, challengedId, ganador])
  await q(`select aplicar_resultado($1)`, [ch.id])
  await q(`update players set ultima_fecha_jugada = now() - interval '1 day' where id = any($1)`,
          [[challengerId, challengedId]])
}
let fallas = 0
const ok = (cond, msg) => { if (!cond) fallas++; console.log(`${cond ? 'OK  ' : 'FALLA'} — ${msg}`) }

try {
  await q('begin')

  // ════════════════════════════════════════════════════════════════════
  // BLOQUE 1 — MIG 032: congelamiento por falta de rivales desafiables
  // ════════════════════════════════════════════════════════════════════

  // ── (m) el #1 se lesiona → el #2 sano queda congelado ─────────────────
  console.log('\n=== (m) el #1 se lesiona: el #2 queda sin rivales ===')
  await reset()
  let p1 = await enPos(1), p2 = await enPos(2), p3 = await enPos(3)
  console.log(`#1 ${p1.j} · #2 ${p2.j} · #3 ${p3.j}`)
  // Tres días normales para que el #2 llegue con un reloj distinto de 0 y se pueda
  // ver que lo CONSERVA al congelarse.
  for (let i = 0; i < 3; i++) await correrCron()
  const m0 = { p1: await ficha(p1.id), p2: await ficha(p2.id), p3: await ficha(p3.id) }
  console.log('tras 3 días normales:', JSON.stringify({ d1: m0.p1.d, d2: m0.p2.d, d3: m0.p3.d }))
  ok(m0.p1.d === 0 && m0.p2.d === 3 && m0.p3.d === 3, 'el #1 sano congelado en 0; #2 y #3 acumulan')

  await lesionar(p1.id, 'Esguince')
  const rm = await correrCron()
  const m1 = { p1: await ficha(p1.id), p2: await ficha(p2.id), p3: await ficha(p3.id) }
  console.log('tras lesionarse el #1:', JSON.stringify({ d1: m1.p1.d, d2: m1.p2.d, d3: m1.p3.d }),
    '· cron:', JSON.stringify({ congelados_sin_rivales: rm.congelados_sin_rivales }))
  ok(m1.p1.d === 1, 'el reloj del #1 LESIONADO corre (es lo que destraba la punta)')
  ok(m1.p2.d === 3, 'el #2 sano queda CONGELADO en 3: su único rival arriba es indesafiable')
  ok(m1.p3.d === 4, 'el #3 sigue acumulando: tiene al #2 sano por encima')
  ok(rm.congelados_sin_rivales === 1, 'el cron reporta 1 congelado sin rivales')

  // El #1 lesionado cruza el umbral y libera la punta.
  await setReloj(p1.id, 13)
  const rm2 = await correrCron()
  const m2 = { p1: await ficha(p1.id), p2: await ficha(p2.id), p3: await ficha(p3.id) }
  console.log('tras cruzar el 14:', JSON.stringify(m2.p1), '·', JSON.stringify(m2.p2))
  console.table(await top(4))
  ok(m2.p1.d === 14 && m2.p1.pos === 3, `el #1 lesionado baja 2 puestos (1 → ${m2.p1.pos})`)
  ok(m2.p2.pos === 1 && m2.p2.d === 3, 'el ex-#2 queda #1 con su reloj conservado en 3 (ni salta ni se borra)')
  ok(rm2.congelados_sin_rivales === 1, 'seguía habiendo exactamente 1 congelado al entrar la corrida')

  // ── (n) #1 y #2 lesionados → el #3 sano queda congelado ───────────────
  console.log('\n=== (n) cascada: #1 y #2 lesionados → se congela el #3 ===')
  await reset()
  p1 = await enPos(1); p2 = await enPos(2); p3 = await enPos(3)
  const p4 = await enPos(4)
  for (let i = 0; i < 2; i++) await correrCron()
  await lesionar(p1.id, 'Esguince'); await lesionar(p2.id, 'Codo')
  const rn = await correrCron()
  const n1 = { p1: await ficha(p1.id), p2: await ficha(p2.id), p3: await ficha(p3.id), p4: await ficha(p4.id) }
  console.log(JSON.stringify({ d1: n1.p1.d, d2: n1.p2.d, d3: n1.p3.d, d4: n1.p4.d }),
    '· cron:', JSON.stringify({ congelados_sin_rivales: rn.congelados_sin_rivales }))
  ok(n1.p1.d === 1 && n1.p2.d === 3, 'los dos lesionados corren (el #1 desde 0, el #2 desde 2)')
  ok(n1.p3.d === 2, 'el #3 sano queda congelado: todos los de arriba están lesionados')
  ok(n1.p4.d === 3, 'el #4 sigue acumulando: tiene al #3 sano arriba')
  ok(rn.congelados_sin_rivales === 1, 'un solo congelado: el #3 (el #4 sí tiene rival)')

  // ── (o) el congelado desafiado desde abajo pierde ─────────────────────
  console.log('\n=== (o) el #3 congelado es desafiado desde abajo y pierde ===')
  const antesO = await ficha(p3.id)
  await jugar(p4.id, p3.id, 'challenger')
  const o1 = await ficha(p3.id)
  console.log(`${p4.j} le gana a ${p3.j}: #${antesO.pos} (d=${antesO.d}) → ${JSON.stringify(o1)}`)
  ok(o1.pos === antesO.pos + 1 && o1.d === 0,
     'baja jugando y aplicar_resultado le deja el reloj en 0: nada especial por estar congelado')

  // ── (p) el #1 se recupera → el #2 vuelve a acumular sin saltos ────────
  console.log('\n=== (p) el #1 se da de alta: el #2 recupera rival ===')
  await reset()
  p1 = await enPos(1); p2 = await enPos(2)
  for (let i = 0; i < 3; i++) await correrCron()          // #2 llega a 3
  await lesionar(p1.id, 'Esguince')
  for (let i = 0; i < 2; i++) await correrCron()          // #2 congelado en 3, #1 corre a 2
  const p_cong = { p1: await ficha(p1.id), p2: await ficha(p2.id) }
  await darDeAlta(p1.id)
  const rp = await correrCron()
  const p_post = { p1: await ficha(p1.id), p2: await ficha(p2.id) }
  console.log('congelado:', JSON.stringify({ d1: p_cong.p1.d, d2: p_cong.p2.d }),
    '→ tras el alta + 1 día:', JSON.stringify({ d1: p_post.p1.d, d2: p_post.p2.d }))
  ok(p_cong.p2.d === 3 && p_post.p2.d === 4,
     'el #2 retoma desde su valor conservado (3 → 4), sin saltos ni reposiciones')
  ok(p_post.p1.d === p_cong.p1.d, 'el #1, ya sano, queda congelado en el valor que traía')
  ok(rp.congelados_sin_rivales === 1, 'ahora el único congelado es el #1')

  // ── (q) ciclo lesión/alta del #1: efecto sobre el #2 ──────────────────
  console.log('\n=== (q) ciclo lesión/alta del #1: el contador del #2 solo pausa o avanza ===')
  await reset()
  p1 = await enPos(1); p2 = await enPos(2)
  const traza = []
  let saltos = 0, avancesEsperados = 0
  for (const estado of ['lesionado', 'lesionado', 'sano', 'lesionado', 'sano', 'sano']) {
    if (estado === 'lesionado') await lesionar(p1.id, 'Ciclo'); else await darDeAlta(p1.id)
    const a1 = (await ficha(p1.id)).d, a2 = (await ficha(p2.id)).d
    await correrCron()
    const b1 = (await ficha(p1.id)).d, b2 = (await ficha(p2.id)).d
    // El #2 avanza exactamente cuando el #1 entró SANO a la corrida (tiene rival).
    if (estado === 'sano') avancesEsperados++
    if (b2 - a2 < 0 || b2 - a2 > 1) saltos++
    if (b1 - a1 < 0 || b1 - a1 > 1) saltos++
    traza.push(`#1 ${estado}: d1 ${a1}→${b1} · d2 ${a2}→${b2}`)
  }
  traza.forEach(t => console.log('  ' + t))
  const q2 = (await ficha(p2.id)).d, q1 = (await ficha(p1.id)).d
  ok(saltos === 0, 'ningún contador salta ni retrocede: cada corrida suma 0 o 1')
  ok(q2 === avancesEsperados, `el #2 avanzó ${q2} días = las ${avancesEsperados} corridas en que el #1 estaba sano`)
  ok(q1 === 3, 'el #1 avanzó 3 días = las 3 corridas en que estaba lesionado; el ciclo no le borró nada')

  // ── (c) el congelado con reloj alto como piso del reacomodo ───────────
  console.log('\n=== (c) el congelado con reloj >= 14 frena la bajada del lesionado de arriba ===')
  await reset()
  p1 = await enPos(1); p2 = await enPos(2)
  await q(`select admin_ajustar_reloj($1, 20, 'test: congelado con reloj alto')`, [p2.id])
  await lesionar(p1.id, 'Esguince')
  await setReloj(p1.id, 13)
  const rc1 = await correrCron()
  const c1 = { p1: await ficha(p1.id), p2: await ficha(p2.id) }
  console.log('#1 lesionado cruza 14 con el #2 congelado en 20:',
    JSON.stringify({ pos1: c1.p1.pos, d1: c1.p1.d, pos2: c1.p2.pos, d2: c1.p2.d }),
    '· cron:', JSON.stringify({ penalizados: rc1.penalizados, movio: rc1.movio }))
  ok(c1.p1.d === 14 && rc1.penalizados === 1, 'el #1 cruza el umbral y entra en _pen')
  ok(c1.p1.pos === 1 && rc1.movio === false,
     'pero NO baja: el #2 congelado está en _barrier (20 >= 14) y lo frena — floor de siempre')
  ok(c1.p2.d === 20, 'el reloj del #2 sigue congelado en 20: el bloqueo no se resuelve solo')
  // No es un bloqueo permanente: el congelado está SANO, así que lo pueden desafiar
  // desde abajo, y al jugar su reloj se va a 0 y sale del barrier.
  const p3c = await enPos(3)
  await jugar(p3c.id, p2.id, 'challenged')      // el #2 defiende y gana → reloj a 0
  ok((await ficha(p2.id)).d === 0, 'el #2 juega (lo desafían desde abajo) y su reloj se va a 0')
  await setReloj(p1.id, 20)
  const rc2 = await correrCron()
  const c2 = await ficha(p1.id)
  console.log('con el #2 fuera del barrier, el #1 cruza el 21:', JSON.stringify(c2),
    '· movio:', rc2.movio)
  ok(c2.d === 21 && c2.pos === 2, 'ahora sí baja: el floor era la única traba')

  // ════════════════════════════════════════════════════════════════════
  // BLOQUE 2 — REGRESIÓN de la mig 031 (el #1 y su reloj congelado)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n\n########## REGRESIÓN 031 ##########')
  await reset()
  const L0 = await enPos(1)
  const control = await enPos(4)
  console.log(`líder: ${L0.j} (#1)   ·   control: ${control.j} (#4)`)

  // ── (a) el #1 sano no acumula; el resto sí ─────────────────────────────
  console.log('\n=== (a) #1 sano congelado durante 5 corridas ===')
  let r
  for (let i = 0; i < 5; i++) r = await correrCron()
  const La = await ficha(L0.id), Ca = await ficha(control.id)
  console.log('líder  :', JSON.stringify(La), '· control:', JSON.stringify(Ca))
  ok(La.d === 0 && La.pos === 1, 'el #1 sano sigue en 0 tras 5 días')
  ok(Ca.d === 5, 'el control acumuló los 5 días')
  ok(r.congelados_sin_rivales === 1, 'el cron reporta el congelamiento del #1')

  // ── (b) #1 sano con reloj sucio → SE CONGELA, no se borra ──────────────
  console.log('\n=== (b) #1 sano con reloj sucio (ajuste de admin a 27) ===')
  await q(`select admin_ajustar_reloj($1, 27, 'test: reloj sucio')`, [L0.id])
  const rb1 = await correrCron()
  const rb2 = await correrCron()
  const Lb = await ficha(L0.id)
  console.log('tras 2 corridas:', JSON.stringify(Lb),
    '· cron:', JSON.stringify({ penalizados: rb2.penalizados, lesionados_nuevos: rb2.lesionados_nuevos }))
  ok(Lb.d === 27, 'el reloj queda CONGELADO en 27 (no se normaliza a 0)')
  ok(Lb.s === 3, 'semanas_inactivo sigue consistente con floor(27/7)')
  ok(Lb.les === false && Lb.pos === 1, 'no lo alcanza ni la auto-lesión ni la penalización (no está en _incr)')
  ok(rb1.penalizados === 0 && rb2.penalizados === 0, 'ninguna de las dos corridas lo penalizó')

  // ── (l) el #1 congelado defiende y gana → reloj a 0 ────────────────────
  console.log('\n=== (l) el #1 congelado en 27 defiende un desafío y gana ===')
  const retadorL = await enPos(3)
  await jugar(retadorL.id, L0.id, 'challenged')
  const Ll = await ficha(L0.id)
  console.log(`${L0.j} (#1) le gana a ${retadorL.j} → ${JSON.stringify(Ll)}`)
  ok(Ll.d === 0 && Ll.s === 0 && Ll.pos === 1, 'jugar es lo único que reinicia el reloj del #1: 27 → 0')

  // ── (k) EXPLOIT: ciclo lesión → alta → lesión del propio #1 ────────────
  console.log('\n=== (k) el ciclo lesión/alta del #1 no borra su reloj ===')
  await lesionar(L0.id, 'Tendinitis')
  for (let i = 0; i < 13; i++) { await limpiarResto([L0.id]); await correrCron() }
  const Lk1 = await ficha(L0.id)
  console.log('tras 13 días lesionado:', JSON.stringify(Lk1))
  ok(Lk1.d === 13 && Lk1.pos === 1, 'el reloj del #1 lesionado llegó a 13 sin cruzar umbral')

  await darDeAlta(L0.id)
  await limpiarResto([L0.id])
  const rk = await correrCron()
  const Lk2 = await ficha(L0.id)
  console.log('tras darse de alta y correr 1 día:', JSON.stringify(Lk2))
  ok(Lk2.d === 13, 'el alta NO borra el reloj: sigue en 13 (con normalización a 0 esto era el exploit)')
  ok(rk.penalizados === 0, 'ese día está sano y congelado: sin penalización')
  console.log(`>> ganancia del ciclo: ${Lk2.d - Lk1.d} días de reloj (el costo es 1 día desafiable)`)

  await lesionar(L0.id, 'Tendinitis')
  await limpiarResto([L0.id])
  const penAntes = await contarLog(L0.id, 'penalización por inactividad')
  const rk2 = await correrCron()
  const Lk3 = await ficha(L0.id)
  const nuevo = await enPos(1)
  console.log('tras volver a lesionarse y correr 1 día:', JSON.stringify(Lk3))
  console.table(await top(4))
  ok(Lk3.d === 14, 'el reloj continúa desde 13 y cruza el 14')
  ok(Lk3.pos === 3, `baja 2 puestos (1 → ${Lk3.pos}): el ciclo no lo salvó`)
  ok(await contarLog(L0.id, 'penalización por inactividad') === penAntes + 1,
     'queda registrada como penalización normal')
  ok((await one(`select count(*)::int n from ranking_log
                  where player_id=$1 and detalle='penalización por inactividad' and desde=1`, [L0.id])).n >= 1,
     'la penalización quedó registrada como "desde la #1"')
  ok(nuevo.les === false && nuevo.pos === 1, `el nuevo #1 (${nuevo.j}) está sano y es desafiable`)

  // ── (d) el nuevo #1 sano queda congelado, no en 0 ──────────────────────
  console.log('\n=== (d) el nuevo #1 sano conserva su reloj ===')
  await setReloj(nuevo.id, 5)
  await correrCron(); await correrCron()
  const Nd = await ficha(nuevo.id)
  console.log(`arrancó en 5 · tras 2 corridas: ${JSON.stringify(Nd)}`)
  ok(Nd.d === 5 && Nd.pos === 1, 'no avanza ni se borra: queda congelado en el valor que traía')

  // ── (e) el ex-#1 lesionado sigue el régimen normal ─────────────────────
  console.log('\n=== (e) el ex-#1 lesionado sigue con 21 y 28 ===')
  for (const [previo, umbral] of [[20, 21], [27, 28]]) {
    await setReloj(L0.id, previo)
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
  const l1 = await enPos(1)
  const retador = await enPos(2)
  await jugar(retador.id, l1.id, 'challenger')
  const exL = await ficha(l1.id)
  console.log(`${retador.j} le gana al #1 ${l1.j} → ex-líder: ${JSON.stringify(exL)}`)
  ok(exL.pos === 2 && exL.d === 0, 'el ex-líder bajó a la #2 con el reloj en 0')
  await correrCron()
  ok((await ficha(l1.id)).d === 1,
     'al día siguiente acumula normal: tiene al nuevo #1 sano por encima')

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
