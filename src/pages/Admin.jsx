import { useState, useEffect } from 'react'
import { getAllPlayers, getChallenges, updatePlayer, updateChallenge, confirmSlotPayment } from '../lib/supabase'
import { notifyRankingUpdated, notifyReminder, notifyChallengeExpired } from '../lib/notify'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Admin() {
  const [players, setPlayers] = useState([])
  const [challenges, setChallenges] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [injureModal, setInjureModal] = useState(null)
  const [injNote, setInjNote] = useState('')
  const [activateModal, setActivateModal] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [pl, ch] = await Promise.all([getAllPlayers(), getChallenges()])
      setPlayers(pl)
      setChallenges(ch)
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
    }
    ntf('Pago validado. El partido está confirmado.')
    load()
  }

  async function expireChallenge(c) {
    await updateChallenge(c.id, { status: 'expired' })
    await notifyChallengeExpired(c.challenger, c.challenged)
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
    const pending = challenges.filter(c =>
      (c.status === 'accepted') && c.slot_day
    ).map(c => ({
      a: `${c.challenger?.nombre} ${c.challenger?.apellido}`,
      b: `${c.challenged?.nombre} ${c.challenged?.apellido}`,
    }))
    if (!pending.length) { ntf('No hay partidos pendientes para recordar.', 'warn'); return }
    await notifyReminder(pending)
    ntf('Recordatorio enviado al grupo.')
  }

  async function resetWeek() {
    await Promise.all(
      players.filter(p => p.activo).map(p => updatePlayer(p.id, { rechazos_mes: 0 }))
    )
    ntf('Semana reseteada. Contadores a cero.')
    load()
  }

  const pendingPayment = challenges.filter(c => c.status === 'accepted' && c.slot_day && !c.pago_confirmado)
  const pendingActivation = players.filter(p => !p.activo)
  const activePlayers = players.filter(p => p.activo).sort((a, b) => (a.posicion || 999) - (b.posicion || 999))

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

      {pendingPayment.length > 0 && (
        <Section title="Validar pagos">
          <div className="card">
            {pendingPayment.map(c => (
              <div key={c.id} className="row-item">
                <div style={{ flex: 1, fontSize: 13 }}>
                  {c.challenger?.nombre} vs {c.challenged?.nombre}
                  <span style={{ fontSize: 12, color: '#888', marginLeft: 6 }}>
                    {c.slot_court} · {c.slot_day} · {c.slot_hour}
                  </span>
                </div>
                <button className="btn btn-accept" style={{ fontSize: 12 }}
                  onClick={() => validatePayment(c)}>Validar</button>
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
              <span style={{ width: 24, textAlign: 'center', fontSize: 12, color: '#888' }}>
                {p.posicion || '—'}
              </span>
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

      {injureModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setInjureModal(null) }}>
          <div className="modal">
            <h3>Marcar lesionado</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {injureModal.nombre} {injureModal.apellido} · no podrá recibir desafíos hasta ser dado de alta
            </p>
            <div className="form-row">
              <label>Descripción (opcional)</label>
              <input type="text" value={injNote} onChange={e => setInjNote(e.target.value)}
                placeholder="ej: Esguince tobillo, codo..." />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setInjureModal(null)}>Cancelar</button>
              <button className="btn btn-reject" onClick={() => markInjured(injureModal)}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {activateModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setActivateModal(null) }}>
          <div className="modal">
            <h3>Activar jugador</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {activateModal.nombre} {activateModal.apellido}
            </p>
            <div className="form-row">
              <label>Posición inicial en el ranking</label>
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
