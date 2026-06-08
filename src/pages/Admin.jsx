import { useState, useEffect } from 'react'
import { getAllPlayers, getChallenges, updatePlayer, updateChallenge, confirmSlotPayment, getCourts, reserveSlot, getWeeklyConfig } from '../lib/supabase'
import { notifyRankingUpdated, notifyReminder, notifyChallengeExpired, notifyPaymentConfirmed } from '../lib/notify'

const HOURS = ['08:00','09:30','11:00','12:30','15:00','16:30','18:00','19:30','21:00']

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Admin() {
  const [players, setPlayers] = useState([])
  const [challenges, setChallenges] = useState([])
  const [courts, setCourts] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [injureModal, setInjureModal] = useState(null)
  const [injNote, setInjNote] = useState('')
  const [activateModal, setActivateModal] = useState(null)
  const [slotModal, setSlotModal] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [pl, ch, co] = await Promise.all([getAllPlayers(), getChallenges(), getCourts()])
      setPlayers(pl)
      setChallenges(ch)
      setCourts(co)
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 4000)
  }

  async function activatePlayer(p, posicion) {
    await updatePlayer(p.id, { activo: true, posicion: parseInt(posicion) })
    setActivateModal(null)
    ntf(`${p.nombre} ${p.apellido} activado en posición #${posicion}.`)
    load()
  }

  async function markInjured(p) {
    await updatePlayer(p.id, { lesionado: true, lesion_nota: injNote })
    setInjureModal(null)
    setInjNote('')
    ntf(`${p.nombre} marcado como lesionado.`, 'warn')
    load()
  }

  async function clearInjury(p) {
    await updatePlayer(p.id, { lesionado: false, lesion_nota: '' })
    ntf(`${p.nombre} dado de alta.`)
    load()
  }

  async function validatePayment(c) {
    await updateChallenge(c.id, { pago_confirmado: true })
    if (c.slot_court && c.slot_day && c.slot_hour) {
      await confirmSlotPayment(c.slot_court, c.slot_day, c.slot_hour)
      const ch = players.find(p => p.id === c.challenger_id)
      const cd = players.find(p => p.id === c.challenged_id)
      const court = courts.find(co => co.id === c.slot_court)
      if (ch && cd && court) {
        await notifyPaymentConfirmed(ch, cd, court.nombre, c.slot_day, c.slot_hour)
      }
    }
    ntf('Pago validado. El partido está confirmado.')
    load()
  }

  async function assignSlot() {
    if (!slotModal?.court || !slotModal?.hour) {
      ntf('Selecciona cancha y hora.', 'warn'); return
    }
    const c = slotModal.challenge
    const today = new Date().toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
    await updateChallenge(c.id, {
      slot_court: slotModal.court,
      slot_day: today,
      slot_hour: slotModal.hour,
      pago_confirmado: slotModal.paid,
    })
    await reserveSlot({
      court_id: slotModal.court,
      dia: today,
      hora: slotModal.hour,
      reserved_by: c.challenger_id,
      challenge_id: c.id,
    })
    if (slotModal.paid) {
      await confirmSlotPayment(slotModal.court, today, slotModal.hour)
    }
    setSlotModal(null)
    ntf(`Cancha asignada${slotModal.paid ? ' y pago confirmado' : ' — pago pendiente'}.`)
    load()
  }

  async function expireChallenge(c) {
    await updateChallenge(c.id, { status: 'expired' })
    const ch = players.find(p => p.id === c.challenger_id)
    const cd = players.find(p => p.id === c.challenged_id)
    if (ch && cd) await notifyChallengeExpired(ch, cd)
    ntf('Desafío caducado.', 'warn')
    load()
  }

  async function publishRanking() {
    const active = players.filter(p => p.activo).sort((a, b) => a.posicion - b.posicion)
    await Promise.all(active.map(p => updatePlayer(p.id, { posicion_anterior: p.posicion })))
    await notifyRankingUpdated('—', active.slice(0, 5))
    ntf('Ranking publicado y notificado al grupo.')
    load()
  }

  async function sendReminder() {
    const pending = challenges.filter(c => c.status === 'accepted').map(c => ({
      a: `${c.challenger?.nombre} ${c.challenger?.apellido}`,
      b: `${c.challenged?.nombre} ${c.challenged?.apellido}`,
    }))
    if (!pending.length) { ntf('No hay partidos pendientes.', 'warn'); return }
    await notifyReminder(pending)
    ntf('Recordatorio enviado al grupo.')
  }

  async function resetWeek() {
    await Promise.all(players.filter(p => p.activo).map(p => updatePlayer(p.id, { rechazos_mes: 0 })))
    ntf('Semana reseteada. Contadores a cero.')
    load()
  }

  const pendingActivation = players.filter(p => !p.activo)
  const activePlayers = players.filter(p => p.activo).sort((a, b) => (a.posicion || 999) - (b.posicion || 999))
  const acceptedChallenges = challenges.filter(c => c.status === 'accepted')

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  return (
    <div>
      {notif && (
        <div className={`notif notif-${notif.type}`}>
          <i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" />
          {notif.msg}
        </div>
      )}

      <Section title="Acciones semanales">
        <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 12px' }}>
          <button className="btn btn-accept" onClick={publishRanking}>
            <i className="ti ti-trophy" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Publicar ranking
          </button>
          <button className="btn btn-warn" onClick={sendReminder}>
            <i className="ti ti-bell" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Recordatorio miércoles
          </button>
          <button className="btn" onClick={resetWeek}>
            <i className="ti ti-refresh" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Resetear semana
          </button>
        </div>
      </Section>

      <Section title={`Desafíos activos (${acceptedChallenges.length})`}>
        <div className="card">
          {acceptedChallenges.length === 0
            ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin desafíos activos</p>
            : acceptedChallenges.map(c => {
              const ch = c.challenger || players.find(p => p.id === c.challenger_id)
              const cd = c.challenged || players.find(p => p.id === c.challenged_id)
              const court = courts.find(co => co.id === c.slot_court)
              return (
                <div key={c.id} className="row-item" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {ch?.nombre} {ch?.apellido} vs {cd?.nombre} {cd?.apellido}
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                      {c.slot_day
                        ? `${court?.nombre || c.slot_court} · ${c.slot_hour} · ${c.pago_confirmado ? '✓ Pago confirmado' : 'Pago pendiente'}`
                        : `Sin cancha · vence ${c.deadline}`
                      }
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {!c.slot_day && (
                      <button className="btn btn-accept" style={{ fontSize: 12 }}
                        onClick={() => setSlotModal({ challenge: c, court: courts[0]?.id, hour: HOURS[6], paid: false })}>
                        Asignar cancha
                      </button>
                    )}
                    {c.slot_day && !c.pago_confirmado && (
                      <button className="btn btn-accept" style={{ fontSize: 12 }}
                        onClick={() => validatePayment(c)}>
                        Validar pago
                      </button>
                    )}
                    {c.pago_confirmado && (
                      <span className="badge badge-green">Listo para jugar</span>
                    )}
                    <button className="btn btn-reject" style={{ fontSize: 12 }}
                      onClick={() => expireChallenge(c)}>
                      Caducar
                    </button>
                  </div>
                </div>
              )
            })
          }
        </div>
      </Section>

      {pendingActivation.length > 0 && (
        <Section title={`Activar jugadores (${pendingActivation.length})`}>
          <div className="card">
            {pendingActivation.map(p => (
              <div key={p.id} className="row-item">
                <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{ini(p.nombre, p.apellido)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>{p.nombre} {p.apellido}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{p.email} · +56 {p.telefono}</div>
                </div>
                <button className="btn btn-accept" style={{ fontSize: 12 }}
                  onClick={() => setActivateModal(p)}>Activar</button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Lesiones">
        <div className="card">
          {activePlayers.map(p => (
            <div key={p.id} className="row-item">
              <span style={{ width: 24, textAlign: 'center', fontSize: 13, color: '#888' }}>{p.posicion}</span>
              <div className="avatar" style={{
                width: 26, height: 26, fontSize: 10,
                background: p.lesionado ? '#FCEBEB' : '#E1F5EE',
                color: p.lesionado ? '#A32D2D' : '#0F6E56',
              }}>{ini(p.nombre, p.apellido)}</div>
              <span style={{ flex: 1, fontSize: 13 }}>
                {p.nombre} {p.apellido}
                {p.lesionado && p.lesion_nota && (
                  <span style={{ fontSize: 11, color: '#A32D2D', marginLeft: 4 }}>· {p.lesion_nota}</span>
                )}
              </span>
              {p.lesionado
                ? <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => clearInjury(p)}>Alta</button>
                : <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={() => { setInjureModal(p); setInjNote('') }}>Lesionado</button>
              }
            </div>
          ))}
        </div>
      </Section>

      <Section title="Todos los jugadores">
        <div className="card">
          {players.map(p => (
            <div key={p.id} className="row-item">
              <span style={{ width: 24, textAlign: 'center', fontSize: 12, color: '#888' }}>{p.posicion || '—'}</span>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{ini(p.nombre, p.apellido)}</div>
              <span style={{ flex: 1, fontSize: 13 }}>{p.nombre} {p.apellido}</span>
              <span style={{ fontSize: 11, color: '#888' }}>{p.victorias || 0}V {p.derrotas || 0}D</span>
              <span className={`badge ${p.activo ? 'badge-green' : 'badge-amber'}`} style={{ fontSize: 10 }}>
                {p.activo ? 'activo' : 'pendiente'}
              </span>
              {p.rechazos_mes >= 2 && (
                <span className="badge badge-red" style={{ fontSize: 10 }}>{p.rechazos_mes} rej.</span>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* Modal asignar cancha — sin campo día */}
      {slotModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Asignar cancha</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {slotModal.challenge.challenger?.nombre} vs {slotModal.challenge.challenged?.nombre}
            </p>
            <div className="form-row">
              <label>Cancha</label>
              <select value={slotModal.court} onChange={e => setSlotModal(s => ({ ...s, court: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
            </div>
            <div className="form-row">
              <label>Hora</label>
              <select value={slotModal.hour} onChange={e => setSlotModal(s => ({ ...s, hour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="paid-check" checked={slotModal.paid}
                onChange={e => setSlotModal(s => ({ ...s, paid: e.target.checked }))}
                style={{ width: 16, height: 16 }} />
              <label htmlFor="paid-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>
                Pago ya confirmado
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSlotModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignSlot}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {injureModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Marcar lesionado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {injureModal.nombre} {injureModal.apellido}
            </p>
            <div className="form-row">
              <label>Descripción (opcional)</label>
              <input type="text" value={injNote} onChange={e => setInjNote(e.target.value)}
                placeholder="ej: Esguince tobillo..." />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setInjureModal(null)}>Cancelar</button>
              <button className="btn btn-reject" onClick={() => markInjured(injureModal)}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {activateModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Activar jugador</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {activateModal.nombre} {activateModal.apellido}
            </p>
            <div className="form-row">
              <label>Posición inicial</label>
              <input type="number" id="act-pos" min="1" max="100" placeholder="ej: 12" />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setActivateModal(null)}>Cancelar</button>
              <button className="btn btn-accept"
                onClick={() => activatePlayer(activateModal, document.getElementById('act-pos').value)}>
                Activar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  )
}
