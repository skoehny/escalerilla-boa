import { useState, useEffect } from 'react'
import { getCourts, getSlots, reserveSlot, getChallenges } from '../lib/supabase'
import { notifySlotReserved } from '../lib/notify'
import { useSession } from '../components/SessionContext'

const HOURS = ['08:00','09:30','11:00','12:30','15:00','16:30','18:00','19:30','21:00']

function getWeekDays() {
  const days = []
  const d = new Date()
  for (let i = 0; i < 7; i++) {
    const day = new Date(d)
    day.setDate(d.getDate() + i)
    const label = day.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })
    days.push(label)
    if (day.getDay() === 3) break // hasta el miércoles
  }
  return days
}

export default function Canchas() {
  const { player } = useSession()
  const [courts, setCourts] = useState([])
  const [slots, setSlots] = useState([])
  const [selectedDay, setSelectedDay] = useState(null)
  const [days] = useState(getWeekDays)
  const [myChallenge, setMyChallenge] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [modal, setModal] = useState(null) // { courtId, day, hour, courtName, surface }

  useEffect(() => {
    setSelectedDay(days[0])
    loadCourts()
    loadMyChallenge()
  }, [])

  useEffect(() => {
    if (selectedDay) loadSlots(selectedDay)
  }, [selectedDay])

  async function loadCourts() {
    const data = await getCourts()
    setCourts(data)
  }

  async function loadSlots(day) {
    setLoading(true)
    try {
      const data = await getSlots(day)
      setSlots(data)
    } finally { setLoading(false) }
  }

  async function loadMyChallenge() {
    const data = await getChallenges()
    const active = data.find(c =>
      (c.challenger_id === player?.id || c.challenged_id === player?.id) &&
      c.status === 'accepted' && !c.slot_day
    )
    setMyChallenge(active || null)
  }

  function ntf(msg, type = 'ok') {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 4000)
  }

  async function handleReserve() {
    if (!modal) return
    try {
      await reserveSlot({
        court_id: modal.courtId,
        dia: modal.day,
        hora: modal.hour,
        reserved_by: player.id,
        challenge_id: myChallenge?.id || null,
      })
      if (myChallenge) {
        const rival = myChallenge.challenger_id === player.id ? myChallenge.challenged : myChallenge.challenger
        await notifySlotReserved(player, rival, modal.courtName, modal.day, modal.hour)
      }
      setModal(null)
      ntf(`Reserva hecha: ${modal.courtName} · ${modal.day} · ${modal.hour}. El admin validará el pago.`)
      loadSlots(selectedDay)
    } catch (err) {
      ntf(err.message, 'err')
    }
  }

  function getSlot(courtId, hour) {
    return slots.find(s => s.court_id === courtId && s.hora === hour)
  }

  const canReserve = !!myChallenge

  return (
    <div>
      {notif && (
        <div className={`notif notif-${notif.type}`}>
          <i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" />
          {notif.msg}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="section-title" style={{ margin: 0 }}>Canchas disponibles</span>
        <span className={`badge ${canReserve ? 'badge-teal' : 'badge-gray'}`}>
          {canReserve ? 'Tienes desafío activo' : 'Solo lectura'}
        </span>
      </div>

      {!canReserve && (
        <div className="notif notif-warn" style={{ marginBottom: 10 }}>
          <i className="ti ti-info-circle" aria-hidden="true" />
          Solo puedes reservar si tienes un desafío aceptado sin cancha asignada.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {days.map(d => (
          <button key={d}
            className={`btn ${selectedDay === d ? 'btn-accept' : ''}`}
            style={{ fontSize: 12, padding: '5px 12px' }}
            onClick={() => setSelectedDay(d)}>
            {d}
          </button>
        ))}
      </div>

      {loading ? <p style={{ color: '#888', fontSize: 13, padding: 16 }}>Cargando horarios...</p> : courts.map(court => (
        <div key={court.id} className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 6,
              background: court.surface === 'arcilla' ? '#FAEEDA' : '#E6F1FB',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <i className="ti ti-tennis"
                style={{ fontSize: 15, color: court.surface === 'arcilla' ? '#BA7517' : '#185FA5' }}
                aria-hidden="true" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{court.nombre}</div>
              <span className={`badge ${court.surface === 'arcilla' ? 'badge-amber' : 'badge-blue'}`}>
                {court.surface}
              </span>
            </div>
          </div>

          {HOURS.map(hour => {
            const slot = getSlot(court.id, hour)
            const isFree = !slot || slot.status === 'free'
            const isMySlot = slot?.reserved_by === player?.id
            const statusLabel = isFree ? 'Disponible · $8.000 pp'
              : slot?.status === 'pending_pay' ? 'Pago pendiente'
              : slot?.status === 'confirmed' ? 'Confirmada'
              : 'Reservada'
            const statusColor = isFree ? '#888'
              : slot?.status === 'confirmed' ? '#3B6D11'
              : '#633806'

            return (
              <div key={hour} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 8,
                border: '0.5px solid #e0dfd8',
                marginBottom: 4,
                background: isFree ? '#fff' : slot?.status === 'confirmed' ? '#EAF3DE' : '#FAEEDA',
                opacity: !isFree && !isMySlot ? 0.7 : 1,
              }}>
                <span style={{ fontSize: 13, fontWeight: 500, width: 48 }}>{hour}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: court.surface === 'arcilla' ? '#BA7517' : '#378ADD', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: statusColor }}>{statusLabel}</span>
                {isMySlot && <span className="badge badge-teal">tuya</span>}
                {isFree && canReserve && (
                  <button className="btn btn-accept" style={{ fontSize: 12, padding: '3px 10px' }}
                    onClick={() => setModal({ courtId: court.id, courtName: court.nombre, surface: court.surface, day: selectedDay, hour })}>
                    Reservar
                  </button>
                )}
                {!isFree && <span className={`badge ${slot?.status === 'confirmed' ? 'badge-green' : 'badge-amber'}`}>
                  {slot?.status === 'confirmed' ? 'confirmada' : 'ocupada'}
                </span>}
              </div>
            )
          })}
        </div>
      ))}

      {modal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setModal(null) }}>
          <div className="modal">
            <h3>Reservar {modal.courtName}</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              {modal.day} · {modal.hour} · {modal.surface} · $8.000 por persona
            </p>
            {myChallenge && (
              <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '8px 10px', fontSize: 12, marginBottom: 12 }}>
                <i className="ti ti-link" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                Se vinculará a tu desafío vs {' '}
                <strong>{myChallenge.challenger_id === player.id
                  ? `${myChallenge.challenged?.nombre} ${myChallenge.challenged?.apellido}`
                  : `${myChallenge.challenger?.nombre} ${myChallenge.challenger?.apellido}`
                }</strong>
              </div>
            )}
            <p style={{ fontSize: 13, color: '#888' }}>
              Tienes 24 h para coordinar el pago con el admin.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={handleReserve}>Confirmar reserva</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
