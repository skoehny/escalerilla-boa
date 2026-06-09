import { useState, useEffect } from 'react'
import { getAllPlayers, getChallenges, updatePlayer, updateChallenge, confirmSlotPayment, getCourts, reserveSlot, supabase } from '../lib/supabase'
import { notifyRankingUpdated, notifyReminder, notifyChallengeExpired, notifyPaymentConfirmed } from '../lib/notify'

const HOURS = ['08:00','09:30','11:00','12:30','15:00','16:30','18:00','19:30','21:00']
function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Admin() {
  const [players, setPlayers] = useState([])
  const [challenges, setChallenges] = useState([])
  const [courts, setCourts] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [injureModal, setInjureModal] = useState(null)
  const [injNote, setInjNote] = useState('')
  const [activateModal, setActivateModal] = useState(null)
  const [slotModal, setSlotModal] = useState(null)
  const [editPlayerModal, setEditPlayerModal] = useState(null)
  const [editResultModal, setEditResultModal] = useState(null)
  const [historialModal, setHistorialModal] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [pl, ch, co] = await Promise.all([getAllPlayers(), getChallenges(), getCourts()])
      setPlayers(pl)
      setChallenges(ch)
      setCourts(co)
      const { data: snaps } = await supabase.from('ranking_snapshots').select('*').order('created_at', { ascending: false }).limit(1)
      setSnapshots(snaps || [])
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  async function publishRanking() {
    const active = players.filter(p => p.activo).sort((a, b) => a.posicion - b.posicion)
    // Guardar snapshot antes de publicar
    const snapshot = active.map(p => ({ player_id: p.id, posicion: p.posicion, posicion_anterior: p.posicion_anterior }))
    await supabase.from('ranking_snapshots').insert({ data: snapshot })
    await Promise.all(active.map(p => updatePlayer(p.id, { posicion_anterior: p.posicion })))
    await notifyRankingUpdated('—', active.slice(0, 5))
    ntf('Ranking publicado. Puedes deshacer si hay un error.')
    load()
  }

  async function undoRanking() {
    if (!snapshots[0]) { ntf('No hay snapshot para deshacer.', 'warn'); return }
    const snap = snapshots[0].data
    await Promise.all(snap.map(s => updatePlayer(s.player_id, { posicion: s.posicion, posicion_anterior: s.posicion_anterior })))
    await supabase.from('ranking_snapshots').delete().eq('id', snapshots[0].id)
    ntf('Ranking restaurado al estado anterior. Los resultados no se modificaron.', 'warn')
    load()
  }

  async function activatePlayer(p, posicion) {
    await updatePlayer(p.id, { activo: true, posicion: parseInt(posicion) })
    setActivateModal(null)
    ntf(`${p.nombre} ${p.apellido} activado en posición #${posicion}.`)
    load()
  }

  async function markInjured(p) {
    await updatePlayer(p.id, { lesionado: true, lesion_nota: injNote })
    setInjureModal(null); setInjNote('')
    ntf(`${p.nombre} marcado como lesionado.`, 'warn')
    load()
  }

  async function clearInjury(p) {
    await updatePlayer(p.id, { lesionado: false, lesion_nota: '' })
    ntf(`${p.nombre} dado de alta.`)
    load()
  }

  async function saveEditPlayer() {
    const p = editPlayerModal
    await updatePlayer(p.id, { nombre: p.nombre, apellido: p.apellido, email: p.email, telefono: p.telefono, posicion: parseInt(p.posicion), es_admin: p.es_admin })
    setEditPlayerModal(null)
    ntf('Perfil actualizado.')
    load()
  }

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
    const day = c.deadline || new Date().toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
    await updateChallenge(c.id, { slot_court: slotModal.court, slot_day: day, slot_hour: slotModal.hour, pago_confirmado: slotModal.paid })
    await reserveSlot({ court_id: slotModal.court, dia: day, hora: slotModal.hour, reserved_by: c.challenger_id, challenge_id: c.id })
    if (slotModal.paid) await confirmSlotPayment(slotModal.court, day, slotModal.hour)
    setSlotModal(null)
    ntf(`Cancha asignada${slotModal.paid ? ' y pago confirmado' : ''}.`)
    load()
  }

  async function saveEditResult() {
    const m = editResultModal
    const sa = parseInt(m.score_a), sb = parseInt(m.score_b)
    if (isNaN(sa) || isNaN(sb)) { ntf('Resultado inválido', 'err'); return }
    await updateChallenge(m.id, { score_a: sa, score_b: sb, ganador: m.ganador })
    setEditResultModal(null)
    ntf('Resultado editado.')
    load()
  }

  async function addHistorial() {
    const h = historialModal
    if (!h.challenger_id || !h.challenged_id || !h.score_a || !h.score_b) { ntf('Completa todos los campos', 'err'); return }
    await supabase.from('challenges').insert({
      challenger_id: h.challenger_id,
      challenged_id: h.challenged_id,
      status: 'completed',
      score_a: parseInt(h.score_a),
      score_b: parseInt(h.score_b),
      ganador: parseInt(h.score_a) > parseInt(h.score_b) ? 'challenger' : 'challenged',
      slot_court: h.court || null,
      slot_day: h.day || null,
      created_at: h.date ? new Date(h.date).toISOString() : new Date().toISOString(),
      pago_confirmado: true,
    })
    setHistorialModal(null)
    ntf('Partido histórico agregado.')
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

  async function sendReminder() {
    const pending = challenges.filter(c => c.status === 'accepted').map(c => ({ a: `${c.challenger?.nombre}`, b: `${c.challenged?.nombre}` }))
    if (!pending.length) { ntf('No hay partidos pendientes.', 'warn'); return }
    await notifyReminder(pending)
    ntf('Recordatorio enviado al grupo.')
  }

  async function resetWeek() {
    await Promise.all(players.filter(p => p.activo).map(p => updatePlayer(p.id, { rechazos_mes: 0 })))
    ntf('Semana reseteada.')
    load()
  }

  const acceptedChallenges = challenges.filter(c => c.status === 'accepted')
  const completedChallenges = challenges.filter(c => c.status === 'completed')
  const pendingActivation = players.filter(p => !p.activo)
  const activePlayers = players.filter(p => p.activo).sort((a, b) => (a.posicion || 999) - (b.posicion || 999))

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      <Section title="Acciones semanales">
        <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 12px' }}>
          <button className="btn btn-accept" onClick={publishRanking}><i className="ti ti-trophy" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Publicar ranking</button>
          {snapshots.length > 0 && <button className="btn btn-warn" onClick={undoRanking}><i className="ti ti-arrow-back" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Deshacer ranking</button>}
          <button className="btn btn-warn" onClick={sendReminder}><i className="ti ti-bell" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Recordatorio</button>
          <button className="btn" onClick={resetWeek}><i className="ti ti-refresh" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Resetear semana</button>
          <button className="btn" onClick={() => setHistorialModal({ challenger_id: '', challenged_id: '', score_a: '', score_b: '', court: '', day: '', date: '' })}>
            <i className="ti ti-history" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Agregar historial
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
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{ch?.nombre} vs {cd?.nombre}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                      {c.slot_day ? `${court?.nombre || c.slot_court} · ${c.slot_day} · ${c.slot_hour} · ${c.pago_confirmado ? '✓ Pago ok' : 'Pago pendiente'}` : `Sin cancha · vence ${c.deadline}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {!c.slot_day && <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => setSlotModal({ challenge: c, court: courts[0]?.id, hour: HOURS[6], paid: false })}>Asignar cancha</button>}
                    {c.slot_day && !c.pago_confirmado && <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => validatePayment(c)}>Validar pago</button>}
                    {c.pago_confirmado && <span className="badge badge-green">Listo</span>}
                    <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={() => expireChallenge(c)}>Caducar</button>
                  </div>
                </div>
              )
            })
          }
        </div>
      </Section>

      <Section title={`Resultados (${completedChallenges.length})`}>
        <div className="card">
          {completedChallenges.length === 0
            ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin resultados</p>
            : completedChallenges.map(c => {
              const ch = c.challenger || players.find(p => p.id === c.challenger_id)
              const cd = c.challenged || players.find(p => p.id === c.challenged_id)
              const w = c.ganador === 'challenger' ? ch : cd
              return (
                <div key={c.id} className="row-item">
                  <span style={{ flex: 1, fontSize: 13 }}>
                    <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{ch?.nombre}</span>
                    <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>{c.score_a}–{c.score_b}</span>
                    <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{cd?.nombre}</span>
                  </span>
                  <span className="badge badge-green" style={{ marginRight: 8 }}>{w?.nombre}</span>
                  <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setEditResultModal({ ...c, challenger: ch, challenged: cd })}>
                    Editar
                  </button>
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
                  <div style={{ fontSize: 11, color: '#888' }}>+56 {p.telefono}</div>
                </div>
                <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => setActivateModal(p)}>Activar</button>
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
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10, background: p.lesionado ? '#FCEBEB' : '#E1F5EE', color: p.lesionado ? '#A32D2D' : '#0F6E56' }}>{ini(p.nombre, p.apellido)}</div>
              <span style={{ flex: 1, fontSize: 13 }}>{p.nombre} {p.apellido}{p.lesionado && p.lesion_nota ? <span style={{ fontSize: 11, color: '#A32D2D', marginLeft: 4 }}>· {p.lesion_nota}</span> : ''}</span>
              {p.lesionado
                ? <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => clearInjury(p)}>Alta</button>
                : <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={() => { setInjureModal(p); setInjNote('') }}>Lesionado</button>}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Jugadores">
        <div className="card">
          {players.map(p => (
            <div key={p.id} className="row-item">
              <span style={{ width: 24, textAlign: 'center', fontSize: 12, color: '#888' }}>{p.posicion || '—'}</span>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{ini(p.nombre, p.apellido)}</div>
              <span style={{ flex: 1, fontSize: 13 }}>{p.nombre} {p.apellido}</span>
              <span className={`badge ${p.activo ? 'badge-green' : 'badge-amber'}`} style={{ fontSize: 10 }}>{p.activo ? 'activo' : 'pendiente'}</span>
              {p.es_admin && <span className="badge badge-blue" style={{ fontSize: 10 }}>admin</span>}
              <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setEditPlayerModal({ ...p })}>Editar</button>
            </div>
          ))}
        </div>
      </Section>

      {/* Modal asignar cancha */}
      {slotModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setSlotModal(null) }}>
          <div className="modal">
            <h3>Asignar cancha</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{slotModal.challenge.challenger?.nombre} vs {slotModal.challenge.challenged?.nombre}</p>
            <div className="form-row"><label>Cancha</label>
              <select value={slotModal.court} onChange={e => setSlotModal(s => ({ ...s, court: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
            </div>
            <div className="form-row"><label>Hora</label>
              <select value={slotModal.hour} onChange={e => setSlotModal(s => ({ ...s, hour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="paid-check" checked={slotModal.paid} onChange={e => setSlotModal(s => ({ ...s, paid: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="paid-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Pago ya confirmado</label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSlotModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignSlot}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar resultado */}
      {editResultModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditResultModal(null) }}>
          <div className="modal">
            <h3>Editar resultado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{editResultModal.challenger?.nombre} vs {editResultModal.challenged?.nombre}</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{editResultModal.challenger?.nombre}</label>
                <input type="number" min="0" max="9" value={editResultModal.score_a} onChange={e => setEditResultModal(m => ({ ...m, score_a: e.target.value }))} />
              </div>
              <div className="form-row" style={{ flex: 1 }}>
                <label>{editResultModal.challenged?.nombre}</label>
                <input type="number" min="0" max="9" value={editResultModal.score_b} onChange={e => setEditResultModal(m => ({ ...m, score_b: e.target.value }))} />
              </div>
            </div>
            <div className="form-row"><label>Ganador</label>
              <select value={editResultModal.ganador} onChange={e => setEditResultModal(m => ({ ...m, ganador: e.target.value }))}>
                <option value="challenger">{editResultModal.challenger?.nombre} {editResultModal.challenger?.apellido}</option>
                <option value="challenged">{editResultModal.challenged?.nombre} {editResultModal.challenged?.apellido}</option>
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditResultModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveEditResult}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar jugador */}
      {editPlayerModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditPlayerModal(null) }}>
          <div className="modal">
            <h3>Editar jugador</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="form-row"><label>Nombre</label><input value={editPlayerModal.nombre || ''} onChange={e => setEditPlayerModal(m => ({ ...m, nombre: e.target.value }))} /></div>
              <div className="form-row"><label>Apellido</label><input value={editPlayerModal.apellido || ''} onChange={e => setEditPlayerModal(m => ({ ...m, apellido: e.target.value }))} /></div>
            </div>
            <div className="form-row"><label>Email</label><input type="email" value={editPlayerModal.email || ''} onChange={e => setEditPlayerModal(m => ({ ...m, email: e.target.value }))} /></div>
            <div className="form-row"><label>Teléfono</label><input value={editPlayerModal.telefono || ''} onChange={e => setEditPlayerModal(m => ({ ...m, telefono: e.target.value }))} /></div>
            <div className="form-row"><label>Posición</label><input type="number" value={editPlayerModal.posicion || ''} onChange={e => setEditPlayerModal(m => ({ ...m, posicion: e.target.value }))} /></div>
            <div className="form-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="admin-check" checked={editPlayerModal.es_admin || false} onChange={e => setEditPlayerModal(m => ({ ...m, es_admin: e.target.checked }))} style={{ width: 16, height: 16 }} />
              <label htmlFor="admin-check" style={{ fontSize: 13, color: '#333', marginBottom: 0 }}>Es administrador</label>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditPlayerModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={saveEditPlayer}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal lesión */}
      {injureModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setInjureModal(null) }}>
          <div className="modal">
            <h3>Marcar lesionado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{injureModal.nombre} {injureModal.apellido}</p>
            <div className="form-row"><label>Descripción (opcional)</label><input type="text" value={injNote} onChange={e => setInjNote(e.target.value)} placeholder="ej: Esguince tobillo..." /></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setInjureModal(null)}>Cancelar</button>
              <button className="btn btn-reject" onClick={() => markInjured(injureModal)}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal activar */}
      {activateModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setActivateModal(null) }}>
          <div className="modal">
            <h3>Activar jugador</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{activateModal.nombre} {activateModal.apellido}</p>
            <div className="form-row"><label>Posición inicial</label><input type="number" id="act-pos" min="1" max="100" placeholder="ej: 12" /></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setActivateModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={() => activatePlayer(activateModal, document.getElementById('act-pos').value)}>Activar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal historial */}
      {historialModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setHistorialModal(null) }}>
          <div className="modal">
            <h3>Agregar partido histórico</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Solo informativo — no mueve el ranking</p>
            <div className="form-row"><label>Jugador A (desafiante)</label>
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
            </div>
            <div className="form-row"><label>Fecha</label><input type="date" value={historialModal.date} onChange={e => setHistorialModal(m => ({ ...m, date: e.target.value }))} /></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setHistorialModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={addHistorial}>Agregar</button>
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
      <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}
