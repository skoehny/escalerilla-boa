import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, getCourts, supabase } from '../lib/supabase'

function fmtDate(d) {
  if (!d) return ''
  if (d.includes('-') && d.length === 10) {
    const dt = new Date(d + 'T12:00:00')
    return dt.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  return d
}
import { notifyChallengeAccepted, notifyChallengeRejected, notifyChallengeExpired } from '../lib/notify'
import { useSession } from '../components/SessionContext'

const HOURS = []
for (let h = 7; h < 22; h++) {
  HOURS.push(`${String(h).padStart(2,'0')}:00`)
  HOURS.push(`${String(h).padStart(2,'0')}:30`)
}

const WA_GROUP = 'https://chat.whatsapp.com/ECl8ws6EkfLKzKuycVrcRo'
const STEPS = ['Pendiente', 'Acordar día', 'Reservar cancha', 'Pago confirmado', 'Jugado']

function stepOf(c) {
  if (c.status === 'pending') return 0
  if (c.status === 'accepted' && !c.slot_day) return 1
  if (c.status === 'accepted' && c.slot_day && !c.pago_confirmado) return 2
  if (c.status === 'accepted' && c.slot_day && c.pago_confirmado) return 3
  if (c.status === 'completed') return 4
  return 0
}

export default function Desafios() {
  const { player } = useSession()
  const [challenges, setChallenges] = useState([])
  const [courts, setCourts] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [slotModal, setSlotModal] = useState(null)
  const [slotError, setSlotError] = useState('')
  const [playedModal, setPlayedModal] = useState(null)  // { id, challenger, challenged }
  const [playedData, setPlayedData] = useState({ court: '', day: '', hour: '18:00', sa: '', sb: '', tba: '', tbb: '' })
  const [playedError, setPlayedError] = useState('')
  const [cancelModal, setCancelModal] = useState(null)  // challenge a cancelar
  const [cancelReason, setCancelReason] = useState('')
  const [cancelOther, setCancelOther] = useState('')
  const isAdminCanchas = player?.es_admin_canchas

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [data, co] = await Promise.all([getChallenges(), getCourts()])
      setChallenges(data)
      setCourts(co)
    } finally { setLoading(false) }
  }

  async function assignSlot() {
    const m = slotModal
    if (!m.court || !m.day || !m.hour) { setSlotError('Completa cancha, día y hora.'); return }
    try {
      const slotDay = m.day
      const ch = challenges.find(x => x.id === m.id)
      const slotStatus = ch?.pago_confirmado ? 'confirmed' : 'reserved'
      // Liberar bloques anteriores (si es edición de una reserva existente)
      await supabase.from('slots').delete().eq('challenge_id', m.id)
      await updateChallenge(m.id, { slot_court: m.court, slot_day: slotDay, slot_hour: m.hour })
      // Block 3 slots in courts table
      const addMins = (h, mins) => {
        const [hh, mm] = h.split(':').map(Number)
        const total = hh * 60 + mm + mins
        return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`
      }
      for (const mins of [0, 30, 60]) {
        await supabase.from('slots').upsert({ court_id: m.court, dia: slotDay, hora: addMins(m.hour, mins), reserved_by: player.id, status: slotStatus, challenge_id: m.id })
      }
      setSlotModal(null)
      ntf(m.editing ? 'Reserva actualizada.' : 'Cancha asignada.')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function releaseSlot(c) {
    try {
      await supabase.from('slots').delete().eq('challenge_id', c.id)
      await updateChallenge(c.id, { slot_court: null, slot_day: null, slot_hour: null, pago_confirmado: false })
      ntf('Cancha liberada. El desafío sigue activo.', 'warn')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function confirmPaymentCanchas(c) {
    try {
      await updateChallenge(c.id, { pago_confirmado: true })
      await supabase.from('slots').update({ status: 'confirmed' }).eq('challenge_id', c.id)
      ntf('Pago confirmado.')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  function ntf(msg, type = 'ok') {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 4000)
  }

  async function accept(c) {
    await updateChallenge(c.id, { status: 'accepted' })
    await notifyChallengeAccepted(c.challenger, c.challenged, c.deadline || 'miércoles')
    ntf('Desafío aceptado. Coordina el día por WhatsApp y luego reserva una cancha.')
    load()
  }

  async function reject(c) {
    await updateChallenge(c.id, { status: 'expired' })
    await notifyChallengeRejected(c.challenger, c.challenged)
    ntf('Desafío rechazado.', 'warn')
    load()
  }

  async function markAsPlayed() {
    const { court, day, hour, sa, sb, tba, tbb } = playedData
    const scoreA = parseInt(sa), scoreB = parseInt(sb)
    if (!court) { setPlayedError('Selecciona la cancha.'); return }
    if (!day) { setPlayedError('Indica la fecha del partido.'); return }
    if (!hour) { setPlayedError('Indica la hora del partido.'); return }
    if (isNaN(scoreA) || isNaN(scoreB)) { setPlayedError('Ingresa el resultado (games de cada uno).'); return }
    if (scoreA < 0 || scoreB < 0 || scoreA > 9 || scoreB > 9) { setPlayedError('Games entre 0 y 9.'); return }
    if (scoreA === scoreB) { setPlayedError('No puede terminar empatado.'); return }
    const isTB = (scoreA === 9 && scoreB === 8) || (scoreA === 8 && scoreB === 9)
    if (isTB && (isNaN(parseInt(tba)) || isNaN(parseInt(tbb)))) { setPlayedError('Ingresa el marcador del tiebreak.'); return }
    const slotDay = day
    try {
      await updateChallenge(playedModal.id, {
        status: 'completed',
        slot_court: court,
        slot_day: slotDay,
        slot_hour: hour,
        score_a: scoreA,
        score_b: scoreB,
        ganador: scoreA > scoreB ? 'challenger' : 'challenged',
        tiebreak_a: isTB ? parseInt(tba) : null,
        tiebreak_b: isTB ? parseInt(tbb) : null,
        anotado_por: player.id,
        ranking_applied: false,
        resultado_validado: false,
      })
      setPlayedModal(null)
      setPlayedData({ court: '', day: '', hour: '18:00', sa: '', sb: '', tba: '', tbb: '' })
      setPlayedError('')
      ntf('Resultado guardado. El rival puede revisarlo en Resultados.')
      load()
    } catch (err) { setPlayedError(err.message) }
  }

  async function cancelChallenge(c) {
    const motivo = cancelReason === 'other' ? (cancelOther.trim() || 'Otro') : cancelReason
    await updateChallenge(c.id, { status: 'expired', cancel_reason: motivo })
    ntf('Desafío cancelado.', 'warn')
    setCancelModal(null); setCancelReason(''); setCancelOther('')
    load()
  }

  const received = challenges.filter(c => c.challenged_id === player?.id && c.status === 'pending')
  const myActive = challenges.find(c =>
    (c.challenger_id === player?.id || c.challenged_id === player?.id) &&
    (c.status === 'pending' || c.status === 'accepted')
  )
  const mySent = challenges.filter(c => c.challenger_id === player?.id && c.status === 'pending')
  const allActive = challenges.filter(c => c.status === 'pending' || c.status === 'accepted')
  const playedThisWeek = challenges.filter(c => c.status === 'completed' && c.ranking_applied === false)

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  // ── Vista Karla (admin canchas) ──────────────────────────
  if (isAdminCanchas) return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}
      <div className="section-title">Desafíos activos</div>
      <div className="card">
        {allActive.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '14px 0' }}>Sin desafíos activos</p>
          : allActive.map(c => (
            <div key={c.id} style={{ borderBottom: '0.5px solid #f0efe8', paddingBottom: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{c.challenger?.nombre} vs {c.challenged?.nombre}</div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                {c.slot_day ? `${c.slot_court} · ${fmtDate(c.slot_day)} · ${c.slot_hour} · ${c.pago_confirmado ? '✓ Pago ok' : 'Pago pendiente'}` : 'Sin cancha · vence ' + fmtDate(c.deadline)}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {!c.slot_day
                  ? <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => setSlotModal({ id: c.id, court: courts[0]?.id, day: '', hour: '18:00' })}>Asignar cancha</button>
                  : <button className="btn" style={{ fontSize: 12 }} onClick={() => setSlotModal({ id: c.id, court: c.slot_court, day: '', hour: c.slot_hour })}>Editar cancha</button>
                }
                {c.slot_day && !c.pago_confirmado && <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => confirmPaymentCanchas(c)}>✓ Pago</button>}
                {c.slot_day && <button className="btn btn-warn" style={{ fontSize: 12 }} onClick={() => releaseSlot(c)}>Liberar cancha</button>}
                {c.pago_confirmado && <span className="badge badge-green">Listo</span>}
              </div>
            </div>
          ))
        }
      </div>

      {/* Modal asignar cancha */}
      {slotModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setSlotModal(null) }}>
          <div className="modal">
            <h3>Asignar cancha</h3>
            <div className="form-row"><label>Cancha</label>
              <select value={slotModal.court} onChange={e => setSlotModal(m => ({ ...m, court: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = slotModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Día</label>
              <input type="date" value={slotModal.day} onChange={e => setSlotModal(m => ({ ...m, day: e.target.value }))} />
            </div>
            <div className="form-row"><label>Hora inicio</label>
              <select value={slotModal.hour} onChange={e => setSlotModal(m => ({ ...m, hour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Se reservarán 3 bloques de 30 min (1.5 horas)</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSlotModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignSlot}>Asignar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  // ── Vista jugador normal ──────────────────────────────────
  return (
    <div>
      {notif && (
        <div className={`notif notif-${notif.type}`}>
          <i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" />
          {notif.msg}
        </div>
      )}

      <p style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
        <i className="ti ti-info-circle" style={{ verticalAlign: -2 }} aria-hidden="true" /> 48 h para aceptar · máx. 2 rechazos/mes · 1 partido/semana · lesionados no pueden ser desafiados
      </p>

      {mySent.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">
            Desafíos enviados pendientes <span className="badge badge-amber">{mySent.length}</span>
          </div>
          {mySent.map(c => (
            <div key={c.id} className="card" style={{ borderColor: '#5DCAA5' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    Desafiaste a {c.challenged?.nombre} {c.challenged?.apellido}
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Esperando respuesta · vence {fmtDate(c.deadline)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-accept" style={{ fontSize: 12, padding: '4px 10px' }}
                    onClick={() => { setPlayedModal({ id: c.id, challenger: c.challenger, challenged: c.challenged }); setPlayedData({ court: courts[0]?.id || '', day: new Date().toLocaleDateString('en-CA'), hour: '18:00', sa: '', sb: '', tba: '', tbb: '' }); setPlayedError('') }}>
                    Jugamos
                  </button>
                  <button className="btn btn-reject" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setCancelModal(c); setCancelReason(''); setCancelOther('') }}>
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {received.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">
            Desafíos recibidos <span className="badge badge-amber">{received.length}</span>
          </div>
          {received.map(c => (
            <div key={c.id} className="card" style={{ borderColor: '#5DCAA5' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
                  {(c.challenger?.nombre?.[0] || '') + (c.challenger?.apellido?.[0] || '')}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {c.challenger?.nombre} {c.challenger?.apellido} te desafió
                  </div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    #{c.challenger?.posicion} vs #{c.challenged?.posicion} · 48 h para responder
                  </div>
                </div>
                <button className="btn btn-reject" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => reject(c)}>Rechazar</button>
                <button className="btn btn-accept" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => accept(c)}>Aceptar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {myActive && myActive.status === 'accepted' && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">Mi desafío activo</div>
          <div className="card" style={{ borderColor: '#5DCAA5' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{myActive.challenger?.nombre} {myActive.challenger?.apellido}</span>
              <span style={{ color: '#888', fontSize: 12 }}>vs</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{myActive.challenged?.nombre} {myActive.challenged?.apellido}</span>
              {myActive.deadline && (
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#A32D2D' }}>vence {fmtDate(myActive.deadline)}</span>
              )}
            </div>

            <div className="flow-steps">
              {STEPS.map((s, i) => {
                const step = stepOf(myActive)
                return (
                  <div key={s} className={`flow-step ${i < step ? 'done' : i === step ? 'now' : ''}`}>
                    {i < step && <i className="ti ti-check" aria-hidden="true" style={{ marginRight: 2 }} />}
                    {s}
                  </div>
                )
              })}
            </div>

            {stepOf(myActive) === 1 && (
              <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
                  <i className="ti ti-messages" style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden="true" />
                  Coordina el día con tu rival. Una vez acordado, cualquiera de los dos reserva la cancha.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <a href={WA_GROUP} target="_blank" rel="noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '0.5px solid #1D9E75', background: '#E1F5EE', color: '#085041', fontSize: 12, fontWeight: 500, textDecoration: 'none' }}>
                    <i className="ti ti-brand-whatsapp" style={{ fontSize: 15 }} aria-hidden="true" />
                    Abrir grupo BOA
                  </a>
                  <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={() => { setSlotModal({ id: myActive.id, court: courts[0]?.id || '', day: '', hour: '18:00' }); setSlotError('') }}>
                    <i className="ti ti-tennis" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                    Reservar cancha
                  </button>
                  <button className="btn btn-reject" style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={() => { setCancelModal(myActive); setCancelReason(''); setCancelOther('') }}>
                    Cancelar desafío
                  </button>
                </div>
              </div>
            )}

            {stepOf(myActive) >= 2 && myActive.slot_court && (
              <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '9px 12px', marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {myActive.slot_court} · {fmtDate(myActive.slot_day)} · {myActive.slot_hour}
                    </div>
                    <div style={{ fontSize: 12, color: myActive.pago_confirmado ? '#3B6D11' : '#888', marginTop: 2 }}>
                      {myActive.pago_confirmado
                        ? <><i className="ti ti-check" aria-hidden="true" style={{ marginRight: 3 }} />Pago confirmado — listo para jugar</>
                        : 'Pago pendiente — el admin validará en breve'}
                    </div>
                  </div>
                  <button className="btn" style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                    onClick={() => setSlotModal({ id: myActive.id, court: myActive.slot_court, day: '', hour: myActive.slot_hour, editing: true })}>
                    <i className="ti ti-pencil" style={{ verticalAlign: -2, marginRight: 3 }} aria-hidden="true" />Editar
                  </button>
                </div>
                {myActive.pago_confirmado && (
                  <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                    Si cambias la reserva, avisa a tu rival por WhatsApp.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="section-title">Todos los desafíos activos</div>
      <div className="card">
        {allActive.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '14px 0' }}>Sin desafíos activos esta semana</p>
          : allActive.map(c => {
            const step = stepOf(c)
            const labels = ['Pendiente', 'Acordando día', 'Cancha reservada', 'Listo para jugar']
            const bCls = ['badge-amber', 'badge-gray', 'badge-teal', 'badge-green']
            return (
              <div key={c.id} className="row-item">
                <span style={{ flex: 1, fontSize: 13 }}>
                  {c.challenger?.nombre} {c.challenger?.apellido}
                  <span style={{ color: '#888', fontSize: 11, margin: '0 4px' }}>vs</span>
                  {c.challenged?.nombre} {c.challenged?.apellido}
                </span>
                <span className={`badge ${bCls[step] || 'badge-gray'}`}>{labels[step] || ''}</span>
                {c.slot_day
                  ? <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>{fmtDate(c.slot_day)}{c.slot_hour ? ` · ${c.slot_hour}` : ''}</span>
                  : c.deadline && <span style={{ fontSize: 11, color: '#A32D2D', marginLeft: 8 }}>vence {fmtDate(c.deadline)}</span>
                }
              </div>
            )
          })
        }
      </div>

      {playedThisWeek.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-title">Jugados esta semana</div>
          <div className="card">
            {playedThisWeek.map(c => {
              const w = c.ganador === 'challenger' ? c.challenger : c.challenged
              const hasTB = c.tiebreak_a != null && c.tiebreak_b != null
              return (
                <div key={c.id} className="row-item">
                  <span style={{ flex: 1, fontSize: 13 }}>
                    <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{c.challenger?.nombre}</span>
                    <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>
                      {c.score_a}–{c.score_b}{hasTB ? ` (${c.tiebreak_a}–${c.tiebreak_b})` : ''}{c.is_wo ? ' (WO)' : ''}
                    </span>
                    <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{c.challenged?.nombre}</span>
                  </span>
                  <span className="badge badge-green" style={{ flexShrink: 0 }}>{w?.nombre}</span>
                  {c.slot_day && <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{fmtDate(c.slot_day)}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal: Marcar como jugado (desafío pendiente sin aceptación formal) */}
      {playedModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setPlayedModal(null) }}>
          <div className="modal" style={{ maxHeight: '85vh', overflowY: 'auto' }}>
            <h3>Registrar partido jugado</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              {playedModal.challenger?.nombre} vs {playedModal.challenged?.nombre} — el rival podrá revisar y editar el resultado.
            </p>
            {playedError && <div className="notif notif-err" style={{ marginBottom: 10 }}>{playedError}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 6 }}>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Cancha *</label>
                <select value={playedData.court} onChange={e => { setPlayedData(d => ({ ...d, court: e.target.value })); setPlayedError('') }}>
                  <option value="">—</option>
                  {courts.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select>
                {(() => { const court = playedData.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Fecha *</label>
                <input type="date" value={playedData.day} onChange={e => { setPlayedData(d => ({ ...d, day: e.target.value })); setPlayedError('') }} />
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label>Hora *</label>
                <select value={playedData.hour} onChange={e => { setPlayedData(d => ({ ...d, hour: e.target.value })); setPlayedError('') }}>
                  {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              <div className="form-row">
                <label>{playedModal.challenger?.nombre} (games) *</label>
                <input type="number" min="0" max="9" value={playedData.sa}
                  onChange={e => { setPlayedData(d => ({ ...d, sa: e.target.value })); setPlayedError('') }}
                  placeholder="0–9" inputMode="numeric" />
              </div>
              <div className="form-row">
                <label>{playedModal.challenged?.nombre} (games) *</label>
                <input type="number" min="0" max="9" value={playedData.sb}
                  onChange={e => { setPlayedData(d => ({ ...d, sb: e.target.value })); setPlayedError('') }}
                  placeholder="0–9" inputMode="numeric" />
              </div>
            </div>

            {((parseInt(playedData.sa) === 9 && parseInt(playedData.sb) === 8) ||
              (parseInt(playedData.sa) === 8 && parseInt(playedData.sb) === 9)) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="form-row">
                  <label>Tiebreak {playedModal.challenger?.nombre} *</label>
                  <input type="number" min="0" value={playedData.tba}
                    onChange={e => setPlayedData(d => ({ ...d, tba: e.target.value }))} inputMode="numeric" />
                </div>
                <div className="form-row">
                  <label>Tiebreak {playedModal.challenged?.nombre} *</label>
                  <input type="number" min="0" value={playedData.tbb}
                    onChange={e => setPlayedData(d => ({ ...d, tbb: e.target.value }))} inputMode="numeric" />
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setPlayedModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={markAsPlayed}>Guardar resultado</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Cancelar desafío con motivo */}
      {cancelModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setCancelModal(null); setCancelReason('') } }}>
          <div className="modal">
            <h3>Cancelar desafío</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              {cancelModal.challenger?.nombre} vs {cancelModal.challenged?.nombre} — ¿cuál es el motivo?
            </p>
            {[
              { id: 'no_response', label: 'Sin respuesta del rival (48h sin aceptar)' },
              { id: 'no_schedule', label: 'No pudimos acordar horario ni cancha' },
              { id: 'injury',      label: 'Lesión de alguno de los dos' },
              { id: 'mutual',      label: 'Acuerdo mutuo — partido no se jugará' },
              { id: 'other',       label: 'Otro motivo' },
            ].map(opt => (
              <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="cancel_reason" value={opt.id}
                  checked={cancelReason === opt.id}
                  onChange={() => { setCancelReason(opt.id); setCancelOther('') }}
                  style={{ width: 16, height: 16, flexShrink: 0 }} />
                {opt.label}
              </label>
            ))}
            {cancelReason === 'other' && (
              <div className="form-row">
                <label>Describe el motivo</label>
                <input type="text" value={cancelOther} onChange={e => setCancelOther(e.target.value)}
                  placeholder="Escribe el motivo..." maxLength={100} />
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => { setCancelModal(null); setCancelReason('') }}>Volver</button>
              <button className="btn btn-reject" disabled={!cancelReason || (cancelReason === 'other' && !cancelOther.trim())}
                onClick={() => cancelChallenge(cancelModal)}>
                Confirmar cancelación
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar reserva (jugador) */}
      {slotModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setSlotModal(null); setSlotError('') } }}>
          <div className="modal">
            <h3>{slotModal.editing ? 'Editar reserva' : 'Reservar cancha'}</h3>
            {slotError && <div className="notif notif-err" style={{ marginBottom: 10 }}>{slotError}</div>}
            <div className="form-row"><label>Cancha</label>
              <select value={slotModal.court} onChange={e => { setSlotModal(m => ({ ...m, court: e.target.value })); setSlotError('') }}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
              {(() => { const court = slotModal.court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
            </div>
            <div className="form-row"><label>Día</label>
              <input type="date" value={slotModal.day} onChange={e => { setSlotModal(m => ({ ...m, day: e.target.value })); setSlotError('') }} />
            </div>
            <div className="form-row"><label>Hora inicio</label>
              <select value={slotModal.hour} onChange={e => { setSlotModal(m => ({ ...m, hour: e.target.value })); setSlotError('') }}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Se reservarán 3 bloques de 30 min (1.5 horas){slotModal.editing ? ' y se liberará la reserva anterior' : ''}</div>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setSlotModal(null); setSlotError('') }}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignSlot}>{slotModal.editing ? 'Guardar cambios' : 'Reservar'}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}