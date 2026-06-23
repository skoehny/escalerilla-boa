import { useState, useEffect } from 'react'
import { getAllPlayers, getChallenges, updatePlayer, updateChallenge, confirmSlotPayment, getCourts, reserveSlot, supabase } from '../lib/supabase'
import { useSession } from '../components/SessionContext'
import { notifyRankingUpdated, notifyReminder, notifyChallengeExpired, notifyPaymentConfirmed, notifyResult } from '../lib/notify'


function courtDot(courtId) {
  const isHard = courtId === 'c3'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: isHard ? '#60B8E0' : '#E8712A',
    marginRight: 4, flexShrink: 0, verticalAlign: 'middle'
  }} title={isHard ? 'Cancha dura' : 'Arcilla'} />
}

const HOURS = []
for (let h = 7; h < 22; h++) {
  HOURS.push(`${String(h).padStart(2,'0')}:00`)
  HOURS.push(`${String(h).padStart(2,'0')}:30`)
}

function fmtDate(d) {
  if (!d) return ''
  if (d && d.length === 10 && d.includes('-')) {
    const dt = new Date(d + 'T12:00:00')
    return dt.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  return d
}

function getNextWednesday() {
  const d = new Date()
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Admin() {
  const [players, setPlayers] = useState([])
  const [challenges, setChallenges] = useState([])
  const [courts, setCourts] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [activeTab, setActiveTab] = useState('acciones')

  // Modals
  const [slotModal, setSlotModal] = useState(null)
  const [editSlotModal, setEditSlotModal] = useState(null)
  const [editPlayerModal, setEditPlayerModal] = useState(null)
  const [editResultModal, setEditResultModal] = useState(null)
  const [historialModal, setHistorialModal] = useState(null)
  const [newChallengeModal, setNewChallengeModal] = useState(null)
  const [newPlayerModal, setNewPlayerModal] = useState(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [publishPreview, setPublishPreview] = useState(null) // plan calculado antes de publicar
  const [inviteShare, setInviteShare] = useState(null) // invitación pendiente de enviar por WA
  const [publishPin, setPublishPin] = useState('')
  const [pinModal, setPinModal] = useState(null) // { action: fn }
  const [pinInput, setPinInput] = useState('')
  const { player: sessionPlayer } = useSession()
  const [resultModal, setResultModal] = useState(null) // ingresar resultado desde admin
  const [woModal, setWoModal] = useState(null)
  const [cancelModal, setCancelModal] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [pl, ch, co] = await Promise.all([getAllPlayers(), getChallenges(), getCourts()])
      setPlayers(pl)
      setChallenges(ch)
      setCourts(co)
      const { data: snaps } = await supabase.from('ranking_snapshots').select('*').order('id', { ascending: false }).limit(1)
      setSnapshots(snaps || [])
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  // ── Ranking ──────────────────────────────────────────────
  async function confirmWithPin(action) {
    setPinInput('')
    setPinModal({ action })
  }

  async function submitPin() {
    if (!pinInput) return
    const { data: ok } = await supabase.rpc('verify_pin', { pin: pinInput, hash: sessionPlayer?.pin_hash })
    if (!ok) { ntf('PIN incorrecto.', 'err'); return }
    const action = pinModal.action
    setPinModal(null)
    setPinInput('')
    try {
      await action()
    } catch (err) {
      ntf('Error al ejecutar la acción: ' + err.message, 'err')
    }
  }

  // Calcula el plan de publicación SIN tocar la BD: posiciones nuevas + explicación de cada movimiento
  async function computePublishPlan() {
    const { data: cfg } = await supabase.from('weekly_config').select('*').eq('id', 1).single()
    // Copia de trabajo para no mutar el estado
    const sim = players.filter(p => p.activo && p.posicion != null)
      .sort((a, b) => a.posicion - b.posicion)
      .map(p => ({ ...p }))
    const originalPos = {}
    sim.forEach(p => { originalPos[p.id] = p.posicion })
    const nm = p => `${p.nombre} ${p.apellido}`
    const reasons = {}   // id -> [explicaciones]
    const addReason = (id, txt) => { (reasons[id] = reasons[id] || []).push(txt) }
    const notas = []     // info adicional (exenciones, defensas)

    // ── PASO 1: Penalizaciones por inactividad (ANTES de los resultados) ──

    // Fase 0: partidos que se aplican ahora → quién jugó esta semana
    const pending = challenges
      .filter(c => c.status === 'completed' && !c.ranking_applied)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const jugaron = new Set()
    pending.forEach(c => { jugaron.add(c.challenger_id); jugaron.add(c.challenged_id) })

    // Clasificación fija: debutante = sin ningún partido completado jamás
    const hasEverPlayedMap = {}
    sim.forEach(p => {
      hasEverPlayedMap[p.id] = (p.victorias || 0) + (p.derrotas || 0) > 0 || jugaron.has(p.id)
    })

    // Paso A+B: actualizar contador semanas_inactivo y calcular penalización
    const penMap = {}
    const nuevasSemanas = {}
    const penaltyLog = []
    for (const p of sim) {
      if (!hasEverPlayedMap[p.id]) { nuevasSemanas[p.id] = 0; continue } // debutante: nunca penalizar
      const n = jugaron.has(p.id) ? 0 : (p.semanas_inactivo || 0) + 1
      nuevasSemanas[p.id] = n
      if (n === 1) notas.push(`${nm(p)} lleva 1 semana sin jugar (sin penalización aún).`)
      if (n <= 1) continue
      const pen = n === 2 ? 2 : 1
      penMap[p.id] = pen
      penaltyLog.push(`${nm(p)} (-${pen})`)
      addReason(p.id, `penalización por inactividad: ${n} semanas sin jugar (-${pen})${p.lesionado ? ' [lesionado]' : ''}`)
    }

    // Paso C: aplicar bajadas bottom-up (inactivo no baja debajo de otro inactivo ni debutante)
    const inactivos = sim.filter(p => (penMap[p.id] || 0) > 0)
      .sort((a, b) => originalPos[b.id] - originalPos[a.id])
    for (const inactivo of inactivos) {
      let idx = sim.indexOf(inactivo)
      for (let step = 0; step < penMap[inactivo.id]; step++) {
        if (idx + 1 >= sim.length) break
        const vecino = sim[idx + 1]
        if ((penMap[vecino.id] || 0) > 0) break        // vecino inactivo → bloquea
        if (!hasEverPlayedMap[vecino.id]) break         // vecino debutante → bloquea
        sim[idx] = vecino; sim[idx + 1] = inactivo; idx++
      }
    }

    // Reasignar posiciones y registrar subidas
    sim.forEach((p, i) => {
      if (!penMap[p.id] && (i + 1) < originalPos[p.id]) {
        addReason(p.id, 'sube por penalizaciones de jugadores más arriba')
      }
      p.posicion = i + 1
    })

    // ── PASO 2: Resultados de partidos (sobre el ranking ya penalizado) ──
    for (const c of pending) {
      const ch = sim.find(p => p.id === c.challenger_id)
      const cd = sim.find(p => p.id === c.challenged_id)
      if (!ch || !cd) continue
      if (c.ganador === 'challenger' && ch.posicion > cd.posicion) {
        const wp = ch.posicion, lp = cd.posicion
        for (const p of sim) {
          if (p.posicion >= lp && p.posicion < wp) {
            p.posicion += 1
            addReason(p.id, `desplazado por el ascenso de ${nm(ch)}`)
          }
        }
        ch.posicion = lp
        addReason(ch.id, `le ganó a ${nm(cd)} (${c.score_a}–${c.score_b}${c.is_wo ? ' WO' : ''}) y toma el puesto #${lp}`)
      } else if (c.ganador === 'challenged') {
        notas.push(`${nm(cd)} defendió su posición #${cd.posicion} ante ${nm(ch)} (${c.score_a}–${c.score_b}${c.is_wo ? ' WO' : ''}) — sin cambios.`)
      }
    }
    sim.sort((a, b) => a.posicion - b.posicion)

    // Movimientos netos con explicación
    const movements = sim
      .filter(p => p.posicion !== originalPos[p.id])
      .map(p => ({
        nombre: nm(p),
        desde: originalPos[p.id],
        hasta: p.posicion,
        delta: originalPos[p.id] - p.posicion, // >0 sube, <0 baja
        motivo: (reasons[p.id] || ['movimiento por reacomodo']).join(' + ')
      }))
      .sort((a, b) => a.hasta - b.hasta)

    return { cfg, sim, originalPos, pending, penaltyLog, movements, notas, nuevasSemanas }
  }

  async function publishRanking(plan) {
    // TEMPORAL: solo SKY puede publicar el ranking ─── borrar cuando se habilite a todos
    if (sessionPlayer?.email?.trim().toLowerCase() !== 'skoehny@gmail.com') {
      ntf('Esta acción debe ser revisada por SKY', 'err')
      return
    }
    // ───────────────────────────────────────────────────────────────────────────
    const { cfg, sim, originalPos, pending, penaltyLog, movements, notas, nuevasSemanas } = plan
    const refreshed = sim
    const nuevaSemana = (cfg?.semana || 0) + 1

    try {
      // ── PASO 1: Guardar historial PRIMERO (si falla, no se toca nada más) ──
      const { error: histError } = await supabase.from('ranking_history').upsert({
        semana: nuevaSemana,
        fecha: new Date().toISOString().split('T')[0],
        publicado_por: 'manual',
        hora_publicacion: new Date().toISOString(),
        data: refreshed.map(p => ({ id: p.id, nombre: p.nombre, apellido: p.apellido, posicion: p.posicion, victorias: p.victorias, derrotas: p.derrotas })),
        movimientos: { movements, notas, penaltyLog },
      }, { onConflict: 'semana' })
      if (histError) {
        ntf('Error al guardar el historial: ' + histError.message + '. No se aplicaron cambios.', 'err')
        return
      }

      // ── PASO 2: Snapshot (para poder deshacer) ──
      await supabase.from('ranking_snapshots').insert({
        data: refreshed.map(p => ({ player_id: p.id, posicion: p.posicion, posicion_anterior: originalPos[p.id] })),
        applied_challenge_ids: pending.map(c => c.id)
      })

      // ── PASO 3: Actualizar posiciones (posicion_anterior = valor real previo) ──
      await Promise.all(sim.map(p =>
        updatePlayer(p.id, { posicion: p.posicion, posicion_anterior: originalPos[p.id], semanas_inactivo: nuevasSemanas[p.id] ?? 0 })
      ))
      await Promise.all(pending.map(c => updateChallenge(c.id, { ranking_applied: true })))

      // ── PASO 4: Avanzar semana ──
      const today = new Date()
      const todayStr = today.toISOString().split('T')[0]
      const nextWed = new Date(today)
      const daysToWed = (3 - today.getDay() + 7) % 7 || 7
      nextWed.setDate(today.getDate() + daysToWed)
      const nextThu = new Date(today)
      const daysToThu = (4 - today.getDay() + 7) % 7 || 7
      nextThu.setDate(today.getDate() + daysToThu)
      await supabase.from('weekly_config').update({
        semana: nuevaSemana,
        fecha_inicio: todayStr,
        fecha_cierre: nextWed.toISOString().split('T')[0],
        fecha_ranking: nextThu.toISOString().split('T')[0],
        publicado_manual: true
      }).eq('id', 1)

      // ── PASO 5: Notificar y cerrar ──
      await notifyRankingUpdated(nuevaSemana, refreshed.slice(0, 5))
      ntf(penaltyLog.length
        ? `Ranking publicado. Penalizaciones por inactividad: ${penaltyLog.join(', ')}.`
        : 'Ranking publicado. Sin penalizaciones por inactividad esta semana.')
      load()

    } catch (err) {
      ntf('Error al publicar el ranking: ' + err.message, 'err')
    }
  }

  async function undoRanking() {
    if (!snapshots[0]) { ntf('No hay snapshot para deshacer.', 'warn'); return }
    if (!confirm('¿Revertir el último ranking publicado? Se restaurarán las posiciones y los partidos volverán a estar pendientes.')) return
    const snap = snapshots[0]
    // posicion_anterior en el snapshot = posicion antes de publicar
    await Promise.all(snap.data.map(s => updatePlayer(s.player_id, { posicion: s.posicion_anterior, posicion_anterior: s.posicion_anterior })))
    // re-abrir los challenges que se marcaron como aplicados en esta publicación
    const ids = snap.applied_challenge_ids
    if (ids && ids.length) {
      await supabase.from('challenges').update({ ranking_applied: false }).in('id', ids)
    } else {
      await supabase.from('challenges').update({ ranking_applied: false }).eq('status', 'completed').eq('ranking_applied', true)
    }
    // borrar historial y snapshot
    const { data: hist } = await supabase.from('ranking_history').select('id').order('id', { ascending: false }).limit(1)
    if (hist?.length) await supabase.from('ranking_history').delete().eq('id', hist[0].id)
    await supabase.from('ranking_snapshots').delete().eq('id', snap.id)
    ntf('Ranking revertido. Posiciones y partidos restaurados.', 'warn')
    load()
  }

  // ── Jugadores ────────────────────────────────────────────
  async function activatePlayer(p, posicion) {
    const pos = posicion ? parseInt(posicion) : (Math.max(...players.filter(x => x.activo && x.posicion).map(x => x.posicion), 0) + 1)
    if (posicion) {
      for (const pl of players) {
        if (pl.id !== p.id && pl.posicion >= pos)
          await updatePlayer(pl.id, { posicion: pl.posicion + 1 })
      }
    }
    await updatePlayer(p.id, { activo: true, posicion: pos })
    ntf(`${p.nombre} activado en #${pos}.`)
    load()
  }

  async function inactivatePlayer(p) {
    await updatePlayer(p.id, { activo: false })
    ntf(`${p.nombre} marcado como inactivo. No aparece en el ranking.`, 'warn')
    load()
  }

  async function saveEditPlayer() {
    const p = editPlayerModal
    // Validar duplicado (excluyendo el mismo jugador)
    const dup = players.find(x => x.id !== p.id && x.nombre?.trim().toLowerCase() === p.nombre?.trim().toLowerCase() && x.apellido?.trim().toLowerCase() === p.apellido?.trim().toLowerCase())
    if (dup) { ntf(`Ya existe otro jugador con el mismo nombre y apellido (#${dup.posicion}).`, 'err'); return }
    if (!p.telefono?.trim() || !/^9\d{8}$/.test(p.telefono)) { ntf('El teléfono debe tener 9 dígitos y empezar con 9 (ej: 912345678).', 'err'); return }
    const newPos = parseInt(p.posicion)
    const oldPos = players.find(x => x.id === p.id)?.posicion
    
    // Reorder other players if position changed
    if (newPos && newPos !== oldPos) {
      if (!oldPos) {
        // Sin posición previa: abrir hueco en newPos
        for (const pl of players) {
          if (pl.id !== p.id && pl.posicion >= newPos)
            await updatePlayer(pl.id, { posicion: pl.posicion + 1 })
        }
      } else if (newPos < oldPos) {
        // Mover arriba: [newPos..oldPos-1] bajan uno
        for (const pl of players) {
          if (pl.id !== p.id && pl.posicion >= newPos && pl.posicion < oldPos)
            await updatePlayer(pl.id, { posicion: pl.posicion + 1 })
        }
      } else {
        // Mover abajo: [oldPos+1..newPos] suben uno
        for (const pl of players) {
          if (pl.id !== p.id && pl.posicion > oldPos && pl.posicion <= newPos)
            await updatePlayer(pl.id, { posicion: pl.posicion - 1 })
        }
      }
    }
    
    await updatePlayer(p.id, { nombre: p.nombre, apellido: p.apellido, email: p.email, telefono: p.telefono, posicion: newPos, es_admin: p.es_admin, wildcard_usada: p.wildcard_usada || false })
    setEditPlayerModal(null)
    ntf('Perfil actualizado. Ranking reordenado.')
    load()
  }

  // ── Desafíos ─────────────────────────────────────────────
  async function validatePayment(c) {
    await updateChallenge(c.id, { pago_confirmado: true })
    if (c.slot_court && c.slot_day && c.slot_hour) {
      await confirmSlotPayment(c.slot_court, c.slot_day, c.slot_hour)
      const ch = players.find(p => p.id === c.challenger_id)
      const cd = players.find(p => p.id === c.challenged_id)
      const court = courts.find(co => co.id === c.slot_court)
      if (ch && cd && court) await notifyPaymentConfirmed(ch, cd, court.nombre, c.slot_day, c.slot_hour)
    }
    ntf('Pago validado.')
    load()
  }

  async function assignSlot() {
    if (!slotModal?.court || !slotModal?.hour) { ntf('Selecciona cancha y hora.', 'warn'); return }
    const c = slotModal.challenge
    const deadline = getNextWednesday()
    const slotDay = slotModal.day || null
    await updateChallenge(c.id, { slot_court: slotModal.court, slot_day: slotDay || deadline, slot_hour: slotModal.hour, pago_confirmado: slotModal.paid })
    if (slotModal.paid) await confirmSlotPayment(slotModal.court, slotDay || deadline, slotModal.hour)
    setSlotModal(null)
    ntf('Cancha asignada.')
    load()
  }


  async function resetPlayerPin(p) {
    try {
      await supabase.from('players').update({ pin_hash: null, pin_reset_solicitado: false }).eq('id', p.id)
      ntf(`PIN reseteado. ${p.nombre} creará uno nuevo al ingresar.`)
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function createPlayer() {
    const p = newPlayerModal
    if (!p.nombre?.trim() || !p.apellido?.trim() || !p.telefono?.trim()) { ntf('Nombre, apellido y teléfono son obligatorios.', 'err'); return }
    if (!/^9\d{8}$/.test(p.telefono)) { ntf('El teléfono debe tener 9 dígitos y empezar con 9 (ej: 912345678).', 'err'); return }
    // Validar duplicado nombre + apellido
    const dup = players.find(x => x.nombre?.trim().toLowerCase() === p.nombre.trim().toLowerCase() && x.apellido?.trim().toLowerCase() === p.apellido.trim().toLowerCase())
    if (dup) { ntf(`Ya existe un jugador con el mismo nombre y apellido (#${dup.posicion}).`, 'err'); return }
    try {
      const lastPos = Math.max(...players.filter(x => x.activo && x.posicion).map(x => x.posicion), 0) + 1
      const { error } = await supabase.from('players').insert({
        nombre: p.nombre.trim(), apellido: p.apellido.trim(),
        telefono: p.telefono.trim(), posicion: lastPos,
        posicion_anterior: lastPos, activo: true,
        es_admin: false, victorias: 0, derrotas: 0,
      })
      if (error) throw error
      const msg = `🎾 *Escalerilla BOA — Club BOA*

Hola ${p.nombre}, te invitamos a unirte a la Escalerilla BOA.

Ingresa en: https://escalerilla-boa.vercel.app

Usa tu número de WhatsApp para registrarte y completar tu perfil.`
      setNewPlayerModal(null)
      // navigator.share debe llamarse directo desde un toque del usuario (iOS);
      // tras el await del insert el permiso expira, así que mostramos un botón dedicado
      setInviteShare({ nombre: `${p.nombre.trim()} ${p.apellido.trim()}`, pos: lastPos, msg })
      load()
    } catch (err) { ntf(err.message || 'Error al agregar jugador', 'err') }
  }

  async function saveEditSlot() {
    const m = editSlotModal
    try {
      const slotDay = m.day || null
      await updateChallenge(m.id, { slot_court: m.court, slot_day: slotDay || m.currentDay, slot_hour: m.hour, pago_confirmado: m.paid })
      setEditSlotModal(null)
      ntf('Partido actualizado.')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function createChallengeAdmin() {
    const m = newChallengeModal
    if (!m.challenger_id || !m.challenged_id) { ntf('Selecciona ambos jugadores.', 'err'); return }
    if (m.challenger_id === m.challenged_id) { ntf('No puede desafiarse a sí mismo.', 'err'); return }
    // Validar disponibilidad
    const ch = players.find(p => p.id === m.challenger_id)
    const cd = players.find(p => p.id === m.challenged_id)
    if (ch?.lesionado) { ntf(`${ch.nombre} está lesionado.`, 'err'); return }
    if (cd?.lesionado) { ntf(`${cd.nombre} está lesionado.`, 'err'); return }
    const chBusy = challenges.some(c => (c.challenger_id === m.challenger_id || c.challenged_id === m.challenger_id) && (c.status === 'pending' || c.status === 'accepted' || (c.status === 'completed' && !c.ranking_applied)))
    const cdBusy = challenges.some(c => (c.challenger_id === m.challenged_id || c.challenged_id === m.challenged_id) && (c.status === 'pending' || c.status === 'accepted' || (c.status === 'completed' && !c.ranking_applied)))
    if (chBusy) { ntf(`${ch?.nombre} ya tiene un desafío esta semana.`, 'err'); return }
    if (cdBusy) { ntf(`${cd?.nombre} ya tiene un desafío esta semana.`, 'err'); return }
    if (ch && cd && ch.posicion && cd.posicion && ch.posicion <= cd.posicion) {
      ntf('El desafiante debe estar en posición inferior al desafiado.', 'err'); return
    }
    try {
      const deadline = getNextWednesday()
      const slotDay = m.day || null
      const { error } = await supabase.from('challenges').insert({
        challenger_id: m.challenger_id,
        challenged_id: m.challenged_id,
        status: 'accepted',
        deadline,
        slot_court: m.court || null,
        slot_day: slotDay,
        slot_hour: m.hour || null,
        pago_confirmado: m.paid || false,
      })
      if (error) throw error
      setNewChallengeModal(null)
      ntf('Desafío creado.')
      load()
    } catch (err) { ntf(err.message || 'Error al crear', 'err') }
  }

  async function adminAcceptChallenge(c) {
    if (!confirm(`¿Aceptar el desafío en nombre de ${c.challenged?.nombre}?`)) return
    try {
      await updateChallenge(c.id, { status: 'accepted' })
      ntf('Desafío aceptado.')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function adminRejectChallenge(c) {
    if (!confirm(`¿Rechazar el desafío en nombre de ${c.challenged?.nombre}?`)) return
    try {
      await updateChallenge(c.id, { status: 'expired' })
      ntf('Desafío rechazado.', 'warn')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function expireChallenge(c) {
    await updateChallenge(c.id, { status: 'expired' })
    const ch = players.find(p => p.id === c.challenger_id)
    const cd = players.find(p => p.id === c.challenged_id)
    if (ch && cd) await notifyChallengeExpired(ch, cd)
    ntf('Desafío caducado.', 'warn')
    load()
  }

  // ── Resultados ───────────────────────────────────────────
  async function saveResult() {
    const m = resultModal
    const sa = parseInt(m.score_a), sb = parseInt(m.score_b)
    if (isNaN(sa) || isNaN(sb)) { ntf('Ingresa los games', 'err'); return }
    if (sa === sb) { ntf('No puede terminar empatado.', 'err'); return }
    if (sa < 0 || sb < 0 || sa > 9 || sb > 9) { ntf('Games entre 0 y 9.', 'err'); return }
    const isTB = (sa === 9 && sb === 8) || (sa === 8 && sb === 9)
    if (isTB) {
      const tba = parseInt(m.tiebreak_a), tbb = parseInt(m.tiebreak_b)
      if (isNaN(tba) || isNaN(tbb) || Math.abs(tba - tbb) < 2) { ntf('Tiebreak inválido — diferencia mínima 2', 'err'); return }
    }
    if (!m.slot_court) { ntf('Selecciona la cancha.', 'err'); return }
    const finalDay = m.slot_day_edit || m.slot_day || null
    if (!finalDay) { ntf('Ingresa la fecha del partido.', 'err'); return }
    if (!m.slot_hour) { ntf('Ingresa la hora del partido.', 'err'); return }
    const slotDay = m.slot_day_edit || finalDay
    const winner = sa > sb ? 'challenger' : 'challenged'
    const ch = players.find(p => p.id === m.challenger_id)
    const cd = players.find(p => p.id === m.challenged_id)
    const winnerP = winner === 'challenger' ? ch : cd
    const loserP = winner === 'challenger' ? cd : ch
    try {
      await updateChallenge(m.id, {
        status: 'completed', score_a: sa, score_b: sb, ganador: winner,
        slot_court: m.slot_court, slot_day: slotDay, slot_hour: m.slot_hour,
        ranking_applied: false, resultado_validado: false,
        ...(isTB ? { tiebreak_a: parseInt(m.tiebreak_a), tiebreak_b: parseInt(m.tiebreak_b) } : { tiebreak_a: null, tiebreak_b: null })
      })
      if (winnerP) await updatePlayer(winnerP.id, { victorias: (winnerP.victorias || 0) + 1 })
      if (loserP) await updatePlayer(loserP.id, { derrotas: (loserP.derrotas || 0) + 1 })
      await notifyResult(ch, cd, sa, sb, winnerP, null)
      setResultModal(null)
      ntf(`Resultado guardado: ${sa}–${sb}. ${winnerP?.nombre} gana.`)
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function saveEditResult() {
    const m = editResultModal
    const sa = parseInt(m.score_a), sb = parseInt(m.score_b)
    if (isNaN(sa) || isNaN(sb)) { ntf('Ingresa el resultado de ambos jugadores.', 'err'); return }
    if (sa === sb) { ntf('No puede terminar empatado.', 'err'); return }
    if (!m.slot_court) { ntf('Selecciona la cancha.', 'err'); return }
    const finalDate = m.slot_day_edit || m.slot_day || null
    if (!finalDate) { ntf('Ingresa la fecha del partido.', 'err'); return }
    const isTB = (sa === 9 && sb === 8) || (sa === 8 && sb === 9)
    const updates = { score_a: sa, score_b: sb, ganador: m.ganador, slot_court: m.slot_court, slot_day: finalDate }
    if (m.slot_day_edit) updates.created_at = new Date(m.slot_day_edit + 'T12:00:00').toISOString()
    if (isTB) {
      const tba = parseInt(m.tiebreak_a), tbb = parseInt(m.tiebreak_b)
      if (isNaN(tba) || isNaN(tbb)) { ntf('Ingresa el resultado del tiebreak.', 'err'); return }
      if (Math.abs(tba - tbb) < 2) { ntf('Tiebreak: diferencia mínima de 2.', 'err'); return }
      updates.tiebreak_a = tba; updates.tiebreak_b = tbb
    } else {
      updates.tiebreak_a = null; updates.tiebreak_b = null
    }
    await updateChallenge(m.id, updates)
    setEditResultModal(null)
    ntf('Resultado editado.')
    load()
  }

  // ── WO ──────────────────────────────────────────────────
  async function declareWO() {
    const m = woModal
    const ch = players.find(p => p.id === m.challenger_id)
    const cd = players.find(p => p.id === m.challenged_id)
    const loser = m.wo_loser === 'challenger' ? ch : cd
    const winner = m.wo_loser === 'challenger' ? cd : ch
    try {
      await updateChallenge(m.id, {
        status: 'completed', score_a: m.wo_loser === 'challenger' ? 0 : 9,
        score_b: m.wo_loser === 'challenger' ? 9 : 0,
        ganador: m.wo_loser === 'challenger' ? 'challenged' : 'challenger',
        is_wo: true,
      })
      if (winner) await updatePlayer(winner.id, { victorias: (winner.victorias || 0) + 1 })
      if (loser) await updatePlayer(loser.id, { derrotas: (loser.derrotas || 0) + 1 })
      // Mover ranking
      if (m.wo_loser === 'challenged' && ch && cd && ch.posicion > cd.posicion) {
        const wp = ch.posicion, lp = cd.posicion
        for (const p of players) {
          if (p.posicion >= lp && p.posicion < wp) await updatePlayer(p.id, { posicion_anterior: p.posicion, posicion: p.posicion + 1 })
        }
        await updatePlayer(ch.id, { posicion_anterior: ch.posicion, posicion: lp })
      }
      setWoModal(null)
      ntf(`W.O. declarado. ${winner?.nombre} gana 9-0.`)
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function cancelMatch() {
    await updateChallenge(cancelModal.id, { status: 'expired' })
    setCancelModal(null)
    ntf('Partido cancelado. Ambos jugadores quedan libres.', 'warn')
    load()
  }

  // ── Historial ─────────────────────────────────────────────
  async function addHistorial() {
    const h = historialModal
    if (!h.challenger_id || !h.challenged_id || !h.score_a || !h.score_b) { ntf('Completa todos los campos', 'err'); return }
    await supabase.from('challenges').insert({
      challenger_id: h.challenger_id, challenged_id: h.challenged_id,
      status: 'completed', score_a: parseInt(h.score_a), score_b: parseInt(h.score_b),
      ganador: parseInt(h.score_a) > parseInt(h.score_b) ? 'challenger' : 'challenged',
      slot_court: h.court || null,
      slot_day: h.date || null,
      created_at: h.date ? new Date(h.date + 'T12:00:00').toISOString() : new Date().toISOString(),
      pago_confirmado: true,
    })
    setHistorialModal(null)
    ntf('Partido histórico agregado.')
    load()
  }

  async function sendReminder() {
    const pending = challenges.filter(c => c.status === 'accepted').map(c => ({ a: c.challenger?.nombre, b: c.challenged?.nombre }))
    if (!pending.length) { ntf('No hay partidos pendientes.', 'warn'); return }
    await notifyReminder(pending)
    ntf('Recordatorio enviado.')
  }



  const acceptedChallenges = challenges.filter(c => c.status === 'accepted')
  const pendingChallenges = challenges.filter(c => c.status === 'pending')
  const completedChallenges = challenges.filter(c => c.status === 'completed')
  const pinResetRequests = players.filter(p => p.pin_reset_solicitado)

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  const tabs = ['acciones', 'desafíos', 'resultados', 'jugadores']

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, borderBottom: '0.5px solid #e0dfd8', overflowX: 'auto' }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding: '8px 14px', fontSize: 13, cursor: 'pointer', border: 'none',
            background: 'transparent', color: activeTab === t ? '#1D9E75' : '#888',
            borderBottom: activeTab === t ? '2px solid #1D9E75' : '2px solid transparent',
            fontWeight: activeTab === t ? 500 : 400, whiteSpace: 'nowrap', marginBottom: -0.5,
          }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {/* ACCIONES */}
      {activeTab === 'acciones' && (
        <div>
          {pinResetRequests.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="section-title">
                Solicitudes de reset de PIN <span className="badge badge-red">{pinResetRequests.length}</span>
              </div>
              <div className="card">
                {pinResetRequests.map(p => (
                  <div key={p.id} className="row-item">
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{p.nombre} {p.apellido}</div>
                      <div style={{ fontSize: 11, color: '#888' }}>+56 {p.telefono}</div>
                    </div>
                    <button className="btn btn-warn" style={{ fontSize: 12 }} onClick={() => resetPlayerPin(p)}>
                      Resetear PIN
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="card" style={{ padding: '10px 12px' }}>

            {/* Grupo Ranking */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-accept" onClick={async () => {
                const day = new Date().getDay()
                if (day !== 4) {
                  if (!confirm('⚠️ La publicación normalmente se hace los JUEVES. ¿Estás seguro de publicar hoy?')) return
                }
                const plan = await computePublishPlan()
                setPublishPreview(plan)
              }}><i className="ti ti-trophy" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Publicar ranking</button>
              {snapshots.length > 0 && <button className="btn btn-warn" onClick={undoRanking}><i className="ti ti-arrow-back" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Deshacer ranking</button>}
            </div>

            <div style={{ borderTop: '0.5px solid #f0efe8', margin: '10px 0' }} />

            {/* Grupo Crear */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-accept" onClick={() => setNewChallengeModal({ challenger_id: '', challenged_id: '', court: '', day: '', hour: '18:00', paid: false })}>
                <i className="ti ti-plus" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Nuevo desafío
              </button>
              <button className="btn btn-accept" onClick={() => setNewPlayerModal({ nombre: '', apellido: '', telefono: '' })}>
                <i className="ti ti-user-plus" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Agregar jugador
              </button>
              <button className="btn" onClick={() => setHistorialModal({ challenger_id: '', challenged_id: '', score_a: '', score_b: '', court: '', date: '' })}>
                <i className="ti ti-history" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Agregar historial
              </button>
            </div>

            <div style={{ borderTop: '0.5px solid #f0efe8', margin: '10px 0' }} />

            {/* Grupo Comunicación */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-warn" onClick={sendReminder}><i className="ti ti-bell" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Recordatorio</button>
              <button className="btn" style={{ borderColor: '#25D366', color: '#128C7E' }} onClick={() => {
                const pending = challenges.filter(c => c.status === 'pending')
                const active = challenges.filter(c => c.status === 'accepted')
                const completed = challenges.filter(c => c.status === 'completed' && c.ranking_applied === false)
                const nm = p => `${p?.nombre || ''} ${p?.apellido || ''}`.trim()
                let msg = '🎾 *Escalerilla BOA — Semana activa*\n\n'
                if (pending.length) {
                  msg += '⏳ *Pendientes de aceptación:*\n'
                  pending.forEach(c => {
                    const ch = players.find(p => p.id === c.challenger_id)
                    const cd = players.find(p => p.id === c.challenged_id)
                    msg += `• ${nm(ch)} desafió a ${nm(cd)}\n`
                  })
                  msg += '\n'
                }
                if (active.length) {
                  msg += '⚔️ *Partidos programados:*\n'
                  active.forEach(c => {
                    const ch = players.find(p => p.id === c.challenger_id)
                    const cd = players.find(p => p.id === c.challenged_id)
                    msg += `• ${nm(ch)} vs ${nm(cd)}${c.slot_day ? ` — ${fmtDate(c.slot_day)}${c.slot_hour ? ', ' + c.slot_hour : ''}` : ' — acordando día'}\n`
                  })
                  msg += '\n'
                }
                if (completed.length) {
                  msg += '✅ *Jugados esta semana:*\n'
                  completed.forEach(c => {
                    const ch = players.find(p => p.id === c.challenger_id)
                    const cd = players.find(p => p.id === c.challenged_id)
                    const w = c.ganador === 'challenger' ? ch : cd
                    const tb = c.tiebreak_a != null ? ` (${c.tiebreak_a}-${c.tiebreak_b})` : ''
                    msg += `• ${nm(ch)} ${c.score_a}-${c.score_b}${tb} ${nm(cd)} → ${nm(w)} gana\n`
                  })
                  msg += '\n'
                }
                msg += '📊 Ver ranking: https://escalerilla-boa.vercel.app'
                if (navigator.share) { navigator.share({ text: msg }) } else { navigator.clipboard.writeText(msg); ntf('Mensaje copiado.') }
              }}>
                <i className="ti ti-brand-whatsapp" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Resumen WA
              </button>
              <button className="btn" onClick={async () => {
                const msg = '🎾 Escalerilla BOA — Club BOA. Ingresa en: https://escalerilla-boa.vercel.app. Si ya eres jugador: entra con tu número de WhatsApp y completa tu perfil. Si quieres unirte: regístrate con tus datos y el admin te activará.'
                if (navigator.share) {
                  await navigator.share({ text: msg })
                } else {
                  await navigator.clipboard.writeText(msg)
                  ntf('Mensaje copiado al portapapeles.')
                }
              }}>
                <i className="ti ti-user-plus" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Invitar jugadores
              </button>
            </div>

          </div>

        </div>
      )}

      {/* DESAFÍOS */}
      {activeTab === 'desafíos' && (
        <div>
          {pendingChallenges.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Pendientes de aceptación ({pendingChallenges.length})</div>
              <div className="card" style={{ marginBottom: 14 }}>
                {pendingChallenges.map(c => {
                  const ch = c.challenger || players.find(p => p.id === c.challenger_id)
                  const cd = c.challenged || players.find(p => p.id === c.challenged_id)
                  return (
                    <div key={c.id} style={{ borderBottom: '0.5px solid #f0efe8', paddingBottom: 10, marginBottom: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{ch?.nombre} {ch?.apellido} → {cd?.nombre} {cd?.apellido}</div>
                      <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>Pendiente · vence {fmtDate(c.deadline)}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => adminAcceptChallenge(c)}>Aceptar</button>
                        <button className="btn btn-warn" style={{ fontSize: 12 }} onClick={() => adminRejectChallenge(c)}>Rechazar</button>
                        <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={() => setCancelModal(c)}>Cancelar</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Desafíos activos ({acceptedChallenges.length})</div>
          <div className="card">
            {acceptedChallenges.length === 0
              ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin desafíos activos</p>
              : acceptedChallenges.map(c => {
                const ch = c.challenger || players.find(p => p.id === c.challenger_id)
                const cd = c.challenged || players.find(p => p.id === c.challenged_id)
                const court = courts.find(co => co.id === c.slot_court)
                return (
                  <div key={c.id} style={{ borderBottom: '0.5px solid #f0efe8', paddingBottom: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{ch?.nombre} {ch?.apellido} vs {cd?.nombre} {cd?.apellido}</div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                      {c.slot_day ? `${court?.nombre || c.slot_court} · ${fmtDate(c.slot_day)} · ${c.slot_hour} · ${c.pago_confirmado ? '✓ Pago ok' : 'Pago pendiente'}` : `Sin cancha · vence ${fmtDate(c.deadline)}`}
                      {c.reagendado ? ' · ⚠️ Reagendado' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {!c.slot_day
                        ? <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => setSlotModal({ challenge: c, court: courts[0]?.id, day: '', hour: '18:00', paid: false })}>Asignar cancha</button>
                        : <button className="btn" style={{ fontSize: 12 }} onClick={() => setEditSlotModal({ id: c.id, court: c.slot_court, currentDay: c.slot_day, day: '', hour: c.slot_hour, paid: c.pago_confirmado })}>Editar</button>
                      }
                      {c.slot_day && !c.pago_confirmado && <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => validatePayment(c)}>Validar pago</button>}
                      <button className="btn btn-accept" style={{ fontSize: 12, borderColor: '#185FA5', color: '#185FA5' }}
                        onClick={() => setResultModal({ ...c, challenger_id: c.challenger_id || c.challenger?.id, challenged_id: c.challenged_id || c.challenged?.id, challenger: ch, challenged: cd, score_a: '', score_b: '', tiebreak_a: '', tiebreak_b: '', slot_court: c.slot_court || courts[0]?.id || '', slot_day_edit: new Date().toLocaleDateString('en-CA'), slot_hour: c.slot_hour || '18:00' })}>
                        Ingresar resultado
                      </button>
                      <button className="btn btn-warn" style={{ fontSize: 12 }}
                        onClick={() => setWoModal({ ...c, challenger_id: c.challenger_id || c.challenger?.id, challenged_id: c.challenged_id || c.challenged?.id, challenger: ch, challenged: cd, wo_loser: 'challenger' })}>
                        W.O.
                      </button>
                      <button className="btn" style={{ fontSize: 12 }} onClick={() => setCancelModal(c)}>Cancelar</button>
                      <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={() => expireChallenge(c)}>Caducar</button>
                    </div>
                  </div>
                )
              })
            }
          </div>
        </div>
      )}

      {/* RESULTADOS */}
      {activeTab === 'resultados' && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Resultados ({completedChallenges.length})</div>
          <div className="card">
            {completedChallenges.length === 0
              ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin resultados</p>
              : completedChallenges.map(c => {
                const ch = c.challenger || players.find(p => p.id === c.challenger_id)
                const cd = c.challenged || players.find(p => p.id === c.challenged_id)
                const w = c.ganador === 'challenger' ? ch : cd
                const hasTB = c.tiebreak_a !== null && c.tiebreak_b !== null
                return (
                  <div key={c.id} className="row-item">
                    <span style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{ch?.nombre}</span>
                      <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>
                        {c.score_a}–{c.score_b}{hasTB ? ` (${c.tiebreak_a}–${c.tiebreak_b})` : ''}{c.is_wo ? ' (WO)' : ''}
                      </span>
                      <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{cd?.nombre}</span>
                    </span>
                    <span className="badge badge-green" style={{ marginRight: 8 }}>{w?.nombre}</span>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => setEditResultModal({ ...c, challenger: ch, challenged: cd, tiebreak_a: c.tiebreak_a || '', tiebreak_b: c.tiebreak_b || '' })}>
                      Editar
                    </button>
                  </div>
                )
              })
            }
          </div>
        </div>
      )}

      {/* JUGADORES */}
      {activeTab === 'jugadores' && (
        <div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
            Activos: {players.filter(p => p.activo).length} · Inactivos: {players.filter(p => !p.activo).length}
          </div>

          {/* Activos */}
          <div className="card">
            {players
              .filter(p => p.activo)
              .sort((a, b) => (a.posicion || 999) - (b.posicion || 999))
              .map(p => (
                <div key={p.id} className="row-item">
                  <span style={{ width: 24, textAlign: 'center', fontSize: 12, color: '#888' }}>{p.posicion}</span>
                  <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{ini(p.nombre, p.apellido)}</div>
                  <span style={{ flex: 1, fontSize: 13, color: p.lesionado ? '#A32D2D' : 'inherit' }}>
                    {p.nombre} {p.apellido}{p.lesionado ? ' (L)' : ''}
                  </span>
                  {p.es_admin && <span className="badge badge-blue" style={{ fontSize: 10 }}>admin</span>}
                  {p.wildcard_usada
                    ? <span style={{ fontSize: 10, color: '#ccc' }}>WC</span>
                    : <span style={{ fontSize: 10, color: '#BA7517', fontWeight: 600 }}>⭐ WC</span>}
                  <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setEditPlayerModal({ ...p })}>Editar</button>
                </div>
              ))}
          </div>

          {/* Inactivos */}
          {players.some(p => !p.activo) && (
            <>
              <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 8px' }}>
                Inactivos ({players.filter(p => !p.activo).length})
              </div>
              <div className="card">
                {players
                  .filter(p => !p.activo)
                  .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
                  .map(p => (
                    <div key={p.id} className="row-item">
                      <div className="avatar" style={{ width: 26, height: 26, fontSize: 10, opacity: 0.5 }}>{ini(p.nombre, p.apellido)}</div>
                      <span style={{ flex: 1, fontSize: 13, color: '#aaa' }}>{p.nombre} {p.apellido}</span>
                      <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
                        onClick={() => setEditPlayerModal({ ...p })}>Editar</button>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── MODALS ── */}

      {/* Ingresar resultado */}
      {resultModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setResultModal(null) }}>
          <div className="modal">
            <h3>Ingresar resultado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{resultModal.challenger?.nombre} vs {resultModal.challenged?.nombre}</p>

            {/* Cancha / Fecha / Hora — siempre obligatorios */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Cancha *</label>
                <select value={resultModal.slot_court} onChange={e => setResultModal(m => ({ ...m, slot_court: e.target.value }))}>
                  <option value="">—</option>
                  {courts.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
                {(() => { const court = resultModal.slot_court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Fecha *</label>
                <input type="date" value={resultModal.slot_day_edit || ''} onChange={e => setResultModal(m => ({ ...m, slot_day_edit: e.target.value }))} />
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Hora *</label>
                <select value={resultModal.slot_hour} onChange={e => setResultModal(m => ({ ...m, slot_hour: e.target.value }))}>
                  {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{resultModal.challenger?.nombre}</label>
                <input type="number" min="0" max="9" value={resultModal.score_a} onChange={e => setResultModal(m => ({ ...m, score_a: e.target.value }))} />
              </div>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{resultModal.challenged?.nombre}</label>
                <input type="number" min="0" max="9" value={resultModal.score_b} onChange={e => setResultModal(m => ({ ...m, score_b: e.target.value }))} />
              </div>
            </div>
            {((String(resultModal.score_a) === '9' && String(resultModal.score_b) === '8') ||
              (String(resultModal.score_a) === '8' && String(resultModal.score_b) === '9')) && (
              <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 8 }}>Tiebreak 9-8</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div className="form-row" style={{ flex: 1 }}>
                    <label>{resultModal.challenger?.nombre}</label>
                    <input type="number" min="0" value={resultModal.tiebreak_a} onChange={e => setResultModal(m => ({ ...m, tiebreak_a: e.target.value }))} />
                  </div>
                  <div className="form-row" style={{ flex: 1 }}>
                    <label>{resultModal.challenged?.nombre}</label>
                    <input type="number" min="0" value={resultModal.tiebreak_b} onChange={e => setResultModal(m => ({ ...m, tiebreak_b: e.target.value }))} />
                  </div>
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setResultModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveResult}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* WO */}
      {woModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setWoModal(null) }}>
          <div className="modal">
            <h3>Declarar W.O.</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{woModal.challenger?.nombre} vs {woModal.challenged?.nombre}</p>
            <div className="notif notif-warn" style={{ marginBottom: 12 }}>
              <i className="ti ti-alert-triangle" aria-hidden="true" /> El perdedor del W.O. pierde 9-0 y baja en el ranking si aplica.
            </div>
            <div className="form-row"><label>¿Quién pierde por W.O.?</label>
              <select value={woModal.wo_loser} onChange={e => setWoModal(m => ({ ...m, wo_loser: e.target.value }))}>
                <option value="challenger">{woModal.challenger?.nombre} {woModal.challenger?.apellido} (desafiante)</option>
                <option value="challenged">{woModal.challenged?.nombre} {woModal.challenged?.apellido} (desafiado)</option>
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setWoModal(null)}>Cancelar</button>
              <button className="btn btn-reject" onClick={declareWO}>Confirmar W.O.</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancelar partido */}
      {cancelModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setCancelModal(null) }}>
          <div className="modal">
            <h3>Cancelar partido</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>Ambos jugadores quedan libres para nuevos desafíos. No afecta el ranking.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setCancelModal(null)}>Volver</button>
              <button className="btn btn-warn" onClick={cancelMatch}>Confirmar cancelación</button>
            </div>
          </div>
        </div>
      )}

      {/* Editar resultado */}
      {editResultModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditResultModal(null) }}>
          <div className="modal">
            <h3>Editar resultado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{editResultModal.challenger?.nombre} vs {editResultModal.challenged?.nombre}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{editResultModal.challenger?.nombre}</label>
                <input type="number" min="0" max="9" value={editResultModal.score_a} onChange={e => setEditResultModal(m => ({ ...m, score_a: e.target.value }))} />
              </div>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{editResultModal.challenged?.nombre}</label>
                <input type="number" min="0" max="9" value={editResultModal.score_b} onChange={e => setEditResultModal(m => ({ ...m, score_b: e.target.value }))} />
              </div>
            </div>
            {((String(editResultModal.score_a) === '9' && String(editResultModal.score_b) === '8') ||
              (String(editResultModal.score_a) === '8' && String(editResultModal.score_b) === '9')) && (
              <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 8 }}>Tiebreak 9-8</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div className="form-row" style={{ flex: 1 }}>
                    <label>{editResultModal.challenger?.nombre}</label>
                    <input type="number" min="0" value={editResultModal.tiebreak_a || ''} onChange={e => setEditResultModal(m => ({ ...m, tiebreak_a: e.target.value }))} />
                  </div>
                  <div className="form-row" style={{ flex: 1 }}>
                    <label>{editResultModal.challenged?.nombre}</label>
                    <input type="number" min="0" value={editResultModal.tiebreak_b || ''} onChange={e => setEditResultModal(m => ({ ...m, tiebreak_b: e.target.value }))} />
                  </div>
                </div>
              </div>
            )}
            <div className="form-row"><label>Ganador</label>
              <select value={editResultModal.ganador} onChange={e => setEditResultModal(m => ({ ...m, ganador: e.target.value }))}>
                <option value="challenger">{editResultModal.challenger?.nombre} {editResultModal.challenger?.apellido}</option>
                <option value="challenged">{editResultModal.challenged?.nombre} {editResultModal.challenged?.apellido}</option>
              </select>
            </div>
            <div className="form-row"><label>Cancha</label>
              <select value={editResultModal.slot_court || ''} onChange={e => setEditResultModal(m => ({ ...m, slot_court: e.target.value }))}>
                <option value="">Sin especificar</option>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = editResultModal.slot_court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Fecha (dejar vacío para no cambiar)</label>
              <input type="date" value={(() => {
                const d = editResultModal.slot_day_edit || ''
                return d
              })()} 
                onChange={e => setEditResultModal(m => ({ ...m, slot_day_edit: e.target.value }))} />
              {editResultModal.slot_day && <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>Fecha actual: {fmtDate(editResultModal.slot_day)}</div>}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditResultModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveEditResult}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Asignar cancha */}
      {slotModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setSlotModal(null) }}>
          <div className="modal">
            <h3>Asignar cancha</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{slotModal.challenge.challenger?.nombre} vs {slotModal.challenge.challenged?.nombre}</p>
            <div className="form-row"><label>Cancha</label>
              <select value={slotModal.court} onChange={e => setSlotModal(s => ({ ...s, court: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = slotModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Día</label>
              <input type="date" value={slotModal.day} onChange={e => setSlotModal(s => ({ ...s, day: e.target.value }))} />
            </div>
            <div className="form-row"><label>Hora</label>
              <select value={slotModal.hour} onChange={e => setSlotModal(s => ({ ...s, hour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="paid-check" checked={slotModal.paid} onChange={e => setSlotModal(s => ({ ...s, paid: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="paid-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Pago confirmado</label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSlotModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignSlot}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Editar cancha/hora */}
      {editSlotModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditSlotModal(null) }}>
          <div className="modal">
            <h3>Editar partido</h3>
            {editSlotModal.paid && <div className="notif notif-ok" style={{ marginBottom: 10 }}><i className="ti ti-check" aria-hidden="true" /> Pago confirmado — se mantendrá</div>}
            <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#888', marginBottom: 10 }}>
              Día actual: <strong>{editSlotModal.currentDay}</strong>
            </div>
            <div className="form-row"><label>Cancha</label>
              <select value={editSlotModal.court || ''} onChange={e => setEditSlotModal(m => ({ ...m, court: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = editSlotModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Nuevo día (dejar vacío para mantener)</label>
              <input type="date" value={editSlotModal.day || ''} onChange={e => setEditSlotModal(m => ({ ...m, day: e.target.value }))} />
            </div>
            <div className="form-row"><label>Hora</label>
              <select value={editSlotModal.hour} onChange={e => setEditSlotModal(m => ({ ...m, hour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="edit-paid" checked={editSlotModal.paid || false} onChange={e => setEditSlotModal(m => ({ ...m, paid: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="edit-paid" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Pago confirmado</label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditSlotModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveEditSlot}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Nuevo desafío */}
      {newChallengeModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setNewChallengeModal(null) }}>
          <div className="modal">
            <h3>Crear desafío</h3>
            <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#888', marginBottom: 10 }}>
              Fecha límite: <strong>{fmtDate(getNextWednesday())}</strong>
            </div>
            <div className="form-row"><label>Desafiante</label>
              <select value={newChallengeModal.challenger_id} onChange={e => setNewChallengeModal(m => ({ ...m, challenger_id: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {players.filter(p => p.activo).map(p => <option key={p.id} value={p.id}>{p.posicion}. {p.nombre} {p.apellido}</option>)}
              </select>
            </div>
            <div className="form-row"><label>Desafiado</label>
              <select value={newChallengeModal.challenged_id} onChange={e => setNewChallengeModal(m => ({ ...m, challenged_id: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {players.filter(p => p.activo).map(p => <option key={p.id} value={p.id}>{p.posicion}. {p.nombre} {p.apellido}</option>)}
              </select>
            </div>
            <div className="form-row"><label>Cancha (opcional)</label>
              <select value={newChallengeModal.court} onChange={e => setNewChallengeModal(m => ({ ...m, court: e.target.value }))}>
                <option value="">Sin asignar</option>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = newChallengeModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            {newChallengeModal.court && <>
              <div className="form-row"><label>Día</label>
                <input type="date" value={newChallengeModal.day} onChange={e => setNewChallengeModal(m => ({ ...m, day: e.target.value }))} />
              </div>
              <div className="form-row"><label>Hora</label>
                <select value={newChallengeModal.hour} onChange={e => setNewChallengeModal(m => ({ ...m, hour: e.target.value }))}>
                  {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </>}
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="new-paid" checked={newChallengeModal.paid} onChange={e => setNewChallengeModal(m => ({ ...m, paid: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="new-paid" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Pago confirmado</label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setNewChallengeModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={createChallengeAdmin}>Crear</button>
            </div>
          </div>
        </div>
      )}

      {/* Vista previa de publicación */}
      {publishPreview && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setPublishPreview(null) }}>
          <div className="modal" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <h3>Vista previa — Semana {publishPreview.cfg?.semana || '—'}</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              Revisa los movimientos antes de publicar. Nada se aplica hasta que confirmes con tu PIN.
            </p>

            {publishPreview.movements.length === 0 ? (
              <div style={{ fontSize: 13, color: '#888', background: '#f5f4f0', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                Sin cambios de posiciones esta semana.
              </div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                  Movimientos ({publishPreview.movements.length})
                </div>
                {publishPreview.movements.map((m, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '0.5px solid #eee', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: m.delta > 0 ? '#3B6D11' : '#A32D2D', flexShrink: 0, width: 30 }}>
                      {m.delta > 0 ? `↑${m.delta}` : `↓${Math.abs(m.delta)}`}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{m.nombre} <span style={{ color: '#888', fontWeight: 400 }}>#{m.desde} → #{m.hasta}</span></div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>{m.motivo}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {publishPreview.notas.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
                  Notas
                </div>
                {publishPreview.notas.map((n, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#666', padding: '4px 0', display: 'flex', gap: 6 }}>
                    <i className="ti ti-info-circle" style={{ fontSize: 14, flexShrink: 0, marginTop: 1, color: '#888' }} aria-hidden="true" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              {publishPreview.pending.length} partido{publishPreview.pending.length !== 1 ? 's' : ''} por aplicar · {publishPreview.penaltyLog.length} penalización{publishPreview.penaltyLog.length !== 1 ? 'es' : ''} por inactividad
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setPublishPreview(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={() => {
                const plan = publishPreview
                setPublishPreview(null)
                confirmWithPin(() => publishRanking(plan))
              }}>Confirmar y publicar</button>
            </div>
          </div>
        </div>
      )}

      {/* Invitación lista para enviar */}
      {inviteShare && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setInviteShare(null) }}>
          <div className="modal">
            <h3>Jugador agregado ✓</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 14 }}>
              <strong>{inviteShare.nombre}</strong> quedó en la posición <strong>#{inviteShare.pos}</strong>. Ahora envíale la invitación:
            </p>
            <button className="btn btn-accept btn-block" style={{ marginBottom: 8 }} onClick={() => {
              if (navigator.share) {
                navigator.share({ text: inviteShare.msg }).catch(() => {})
              } else {
                navigator.clipboard.writeText(inviteShare.msg)
                ntf('Invitación copiada al portapapeles.')
              }
              setInviteShare(null)
            }}>
              <i className="ti ti-brand-whatsapp" style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden="true" />
              Enviar invitación por WhatsApp
            </button>
            <button className="btn btn-block" onClick={() => {
              navigator.clipboard.writeText(inviteShare.msg)
              ntf('Invitación copiada al portapapeles.')
              setInviteShare(null)
            }}>
              <i className="ti ti-copy" style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden="true" />
              Copiar mensaje
            </button>
            <button className="btn btn-block" style={{ marginTop: 6, color: '#888' }} onClick={() => setInviteShare(null)}>
              Omitir
            </button>
          </div>
        </div>
      )}

      {/* Confirmar PIN */}
      {pinModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setPinModal(null); setPinInput('') } }}>
          <div className="modal">
            <h3>Confirmar acción</h3>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>Ingresá tu PIN de administrador para continuar.</p>
            <div className="form-row">
              <label>PIN</label>
              <input type="password" inputMode="numeric" value={pinInput} onChange={e => setPinInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitPin()} autoFocus />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setPinModal(null); setPinInput('') }}>Cancelar</button>
              <button className="btn btn-accept" onClick={submitPin}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {/* Agregar jugador */}
      {newPlayerModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setNewPlayerModal(null) }}>
          <div className="modal">
            <h3>Agregar jugador</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Quedará activo en la última posición.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="form-row"><label>Nombre</label><input value={newPlayerModal.nombre} onChange={e => setNewPlayerModal(m => ({ ...m, nombre: e.target.value }))} placeholder="Juan" /></div>
              <div className="form-row"><label>Apellido</label><input value={newPlayerModal.apellido} onChange={e => setNewPlayerModal(m => ({ ...m, apellido: e.target.value }))} placeholder="Pérez" /></div>
            </div>
            <div className="form-row">
              <label>Teléfono</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 10px', background: '#f5f4f0', border: '0.5px solid #ccc', borderRadius: 8, fontSize: 13, color: '#888', height: 36 }}>🇨🇱 +56</span>
                <input value={newPlayerModal.telefono} onChange={e => setNewPlayerModal(m => ({ ...m, telefono: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="912345678" style={{ flex: 1 }} inputMode="numeric" maxLength={9} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setNewPlayerModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={() => createPlayer()}>Agregar y enviar invitación</button>
            </div>
          </div>
        </div>
      )}

      {/* Historial */}
      {historialModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setHistorialModal(null) }}>
          <div className="modal">
            <h3>Agregar partido histórico</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Solo informativo — no mueve el ranking</p>
            <div className="form-row"><label>Jugador A</label>
              <select value={historialModal.challenger_id} onChange={e => setHistorialModal(m => ({ ...m, challenger_id: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.nombre} {p.apellido}</option>)}
              </select>
            </div>
            <div className="form-row"><label>Jugador B</label>
              <select value={historialModal.challenged_id} onChange={e => setHistorialModal(m => ({ ...m, challenged_id: e.target.value }))}>
                <option value="">Seleccionar...</option>
                {players.map(p => <option key={p.id} value={p.id}>{p.nombre} {p.apellido}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="form-row" style={{ flex: 1 }}><label>Games A</label><input type="number" min="0" max="9" value={historialModal.score_a} onChange={e => setHistorialModal(m => ({ ...m, score_a: e.target.value }))} /></div>
              <div className="form-row" style={{ flex: 1 }}><label>Games B</label><input type="number" min="0" max="9" value={historialModal.score_b} onChange={e => setHistorialModal(m => ({ ...m, score_b: e.target.value }))} /></div>
            </div>
            <div className="form-row"><label>Cancha</label>
              <select value={historialModal.court} onChange={e => setHistorialModal(m => ({ ...m, court: e.target.value }))}>
                <option value="">Sin especificar</option>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = historialModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Fecha</label><input type="date" value={historialModal.date} onChange={e => setHistorialModal(m => ({ ...m, date: e.target.value }))} /></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setHistorialModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={addHistorial}>Agregar</button>
            </div>
          </div>
        </div>
      )}

      {/* Editar jugador */}
      {editPlayerModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditPlayerModal(null) }}>
          <div className="modal">
            <h3>Editar jugador</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="form-row"><label>Nombre</label><input value={editPlayerModal.nombre || ''} onChange={e => setEditPlayerModal(m => ({ ...m, nombre: e.target.value }))} /></div>
              <div className="form-row"><label>Apellido</label><input value={editPlayerModal.apellido || ''} onChange={e => setEditPlayerModal(m => ({ ...m, apellido: e.target.value }))} /></div>
            </div>
            <div className="form-row"><label>Email</label><input type="email" value={editPlayerModal.email || ''} onChange={e => setEditPlayerModal(m => ({ ...m, email: e.target.value }))} /></div>
            <div className="form-row">
              <label>Teléfono</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', padding: '0 10px', background: '#f5f4f0', border: '0.5px solid #ccc', borderRadius: 8, fontSize: 13, color: '#888', height: 36 }}>🇨🇱 +56</span>
                <input value={editPlayerModal.telefono || ''} onChange={e => setEditPlayerModal(m => ({ ...m, telefono: e.target.value.replace(/[^0-9]/g, '') }))} inputMode="numeric" maxLength={9} placeholder="912345678" style={{ flex: 1 }} />
              </div>
            </div>
            <div className="form-row"><label>Posición</label><input type="number" value={editPlayerModal.posicion || ''} onChange={e => setEditPlayerModal(m => ({ ...m, posicion: e.target.value }))} /></div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="admin-check" checked={editPlayerModal.es_admin || false} onChange={e => setEditPlayerModal(m => ({ ...m, es_admin: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="admin-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Es administrador</label>
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="wc-check" checked={editPlayerModal.wildcard_usada || false} onChange={e => setEditPlayerModal(m => ({ ...m, wildcard_usada: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="wc-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Wild Card usada {editPlayerModal.wildcard_usada ? '(marcar para quitar)' : '(marcar para registrar como usada)'}</label>
            </div>

            {/* ── ACCIONES DEL JUGADOR ── */}
            <div style={{ borderTop: '0.5px solid #e0dfd8', marginTop: 14, paddingTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Acciones</div>

              {/* Lesión */}
              {editPlayerModal.lesionado ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#A32D2D', marginBottom: 6 }}>
                    <i className="ti ti-first-aid-kit" style={{ marginRight: 4 }} aria-hidden="true" />
                    Lesionado{editPlayerModal.lesion_nota ? `: ${editPlayerModal.lesion_nota}` : ''}
                  </div>
                  <button className="btn btn-accept" style={{ fontSize: 12, width: '100%' }}
                    onClick={async () => {
                      await updatePlayer(editPlayerModal.id, { lesionado: false, lesion_nota: '' })
                      setEditPlayerModal(null)
                      ntf(`${editPlayerModal.nombre} dado de alta.`)
                      load()
                    }}>
                    Dar de alta
                  </button>
                </div>
              ) : (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      placeholder="Nota de lesión (opcional)"
                      value={editPlayerModal._injNote || ''}
                      onChange={e => setEditPlayerModal(m => ({ ...m, _injNote: e.target.value }))}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="btn btn-reject" style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                      onClick={async () => {
                        await updatePlayer(editPlayerModal.id, { lesionado: true, lesion_nota: editPlayerModal._injNote || '' })
                        setEditPlayerModal(null)
                        ntf(`${editPlayerModal.nombre} marcado como lesionado.`, 'warn')
                        load()
                      }}>
                      Marcar lesionado
                    </button>
                  </div>
                </div>
              )}

              {/* Activar / Inactivar */}
              {editPlayerModal.activo ? (
                <div style={{ marginBottom: 10 }}>
                  <button className="btn btn-warn" style={{ fontSize: 12, width: '100%' }}
                    onClick={() => { inactivatePlayer(editPlayerModal); setEditPlayerModal(null) }}>
                    Inactivar jugador
                  </button>
                </div>
              ) : (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      placeholder="Posición (vacío = último)"
                      value={editPlayerModal._activatePos || ''}
                      onChange={e => setEditPlayerModal(m => ({ ...m, _activatePos: e.target.value }))}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="btn btn-accept" style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                      onClick={() => { activatePlayer(editPlayerModal, editPlayerModal._activatePos); setEditPlayerModal(null) }}>
                      Activar
                    </button>
                  </div>
                </div>
              )}

              {/* Resetear PIN */}
              <button className="btn btn-warn" style={{ fontSize: 12, width: '100%' }}
                onClick={() => {
                  if (confirm(`¿Resetear el PIN de ${editPlayerModal.nombre} ${editPlayerModal.apellido}? Deberá crear uno nuevo al ingresar.`)) {
                    resetPlayerPin(editPlayerModal)
                    setEditPlayerModal(null)
                  }
                }}>
                <i className="ti ti-key" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                Resetear PIN
              </button>
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setEditPlayerModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveEditPlayer}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
