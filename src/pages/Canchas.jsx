import { useState, useEffect } from 'react'
import { getCourts, getSlots, reserveSlot, getChallenges, updateChallenge } from '../lib/supabase'
import { notifySlotReserved } from '../lib/notify'
import { useSession } from '../components/SessionContext'

const HOURS = []
for (let h = 7; h < 22; h++) {
  HOURS.push(`${String(h).padStart(2,'0')}:00`)
  HOURS.push(`${String(h).padStart(2,'0')}:30`)
}

function getDays() {
  const days = []
  const d = new Date()
  for (let i = 0; i < 14; i++) {
    const day = new Date(d)
    day.setDate(d.getDate() + i)
    days.push({
      label: day.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' }),
      date: day,
    })
    if (day.getDay() === 3 && i > 0) break
  }
  return days
}

export default function Canchas() {
  const { player } = useSession()
  const isAdminCanchas = player?.es_admin_canchas || player?.es_admin
  const [courts, setCourts] = useState([])
  const [slots, setSlots] = useState([])
  const [days] = useState(getDays)
  const [selectedDay, setSelectedDay] = useState(null)
  const [myChallenge, setMyChallenge] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [modal, setModal] = useState(null)
  const [editModal, setEditModal] = useState(null)
  const [blockModal, setBlockModal] = useState(null)
  const [assignModal, setAssignModal] = useState(null)
  const [allChallenges, setAllChallenges] = useState([])

  useEffect(() => {
    setSelectedDay(days[0]?.label)
    loadCourts()
    loadMyChallenge()
  }, [])

  useEffect(() => { if (selectedDay) loadSlots(selectedDay) }, [selectedDay])

  async function loadCourts() { const data = await getCourts(); setCourts(data) }
  async function loadSlots(day) { setLoading(true); try { const data = await getSlots(day); setSlots(data) } finally { setLoading(false) } }
  useEffect(() => { if (isAdminCanchas) loadAllChallenges() }, [])

  async function loadAllChallenges() {
    const data = await getChallenges()
    setAllChallenges(data.filter(c => c.status === 'accepted' && !c.slot_day))
  }

  async function loadMyChallenge() {
    const data = await getChallenges()
    const active = data.find(c => (c.challenger_id === player?.id || c.challenged_id === player?.id) && c.status === 'accepted' && !c.slot_day)
    setMyChallenge(active || null)
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  async function blockSlot() {
    if (!blockModal) return
    const { supabase } = await import('../lib/supabase')
    try {
      await supabase.from('slots').upsert({
        court_id: blockModal.courtId, dia: selectedDay, hora: blockModal.hour,
        reserved_by: player.id, status: 'reserved', challenge_id: null
      })
      setBlockModal(null)
      ntf('Horario bloqueado (30 min).')
      loadSlots(selectedDay)
    } catch (err) { ntf(err.message, 'err') }
  }

  async function unblockSlot(slot) {
    const { supabase } = await import('../lib/supabase')
    try {
      await supabase.from('slots').delete().eq('id', slot.id)
      ntf('Horario liberado.')
      loadSlots(selectedDay)
    } catch (err) { ntf(err.message, 'err') }
  }

  async function assignToChallengeSlot() {
    if (!assignModal) return
    try {
      const { supabase } = await import('../lib/supabase')
      const { importChallenge } = assignModal
      const day = selectedDay
      const hour = assignModal.hour
      const courtId = assignModal.courtId

      // Block 3 slots (1.5 hours = 3 x 30min)
      const addMins = (h, mins) => {
        const [hh, mm] = h.split(':').map(Number)
        const total = hh * 60 + mm + mins
        return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`
      }
      await supabase.from('slots').upsert({ court_id: courtId, dia: day, hora: hour, reserved_by: player.id, status: 'reserved', challenge_id: importChallenge.id })
      await supabase.from('slots').upsert({ court_id: courtId, dia: day, hora: addMins(hour, 30), reserved_by: player.id, status: 'reserved', challenge_id: importChallenge.id })
      await supabase.from('slots').upsert({ court_id: courtId, dia: day, hora: addMins(hour, 60), reserved_by: player.id, status: 'reserved', challenge_id: importChallenge.id })

      await updateChallenge(importChallenge.id, { slot_court: courtId, slot_day: day, slot_hour: hour })
      setAssignModal(null)
      ntf(`Cancha asignada a ${importChallenge.challenger?.nombre} vs ${importChallenge.challenged?.nombre}`)
      loadSlots(selectedDay)
      loadAllChallenges()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function confirmPayment(slot) {
    try {
      const { supabase } = await import('../lib/supabase')
      await supabase.from('slots').update({ status: 'confirmed' }).eq('id', slot.id)
      if (slot.challenge_id) await updateChallenge(slot.challenge_id, { pago_confirmado: true })
      ntf('Pago confirmado.')
      loadSlots(selectedDay)
    } catch (err) { ntf(err.message, 'err') }
  }

  async function handleReserve() {
    if (!modal) return
    try {
      await reserveSlot({ court_id: modal.courtId, dia: modal.day, hora: modal.hour, reserved_by: player.id, challenge_id: myChallenge?.id || null })
      if (myChallenge) {
        await updateChallenge(myChallenge.id, { slot_court: modal.courtId, slot_day: modal.day, slot_hour: modal.hour })
        const rival = myChallenge.challenger_id === player.id ? myChallenge.challenged : myChallenge.challenger
        const court = courts.find(c => c.id === modal.courtId)
        await notifySlotReserved(player, rival, court?.nombre || modal.courtId, modal.day, modal.hour)
      }
      setModal(null)
      ntf(`Reserva hecha: ${modal.courtName} · ${modal.day} · ${modal.hour}`)
      loadSlots(selectedDay)
      loadMyChallenge()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function handleEdit() {
    if (!editModal) return
    const slot = editModal.slot
    try {
      const { supabase } = await import('../lib/supabase')
      // Update slot
      await supabase.from('slots').update({
        court_id: editModal.newCourt,
        dia: editModal.newDay,
        hora: editModal.newHour,
        status: slot.confirmedPay ? 'confirmed' : 'reserved',
      }).eq('id', slot.id)
      // Update challenge if linked
      if (slot.challenge_id) {
        await updateChallenge(slot.challenge_id, {
          slot_court: editModal.newCourt,
          slot_day: editModal.newDay,
          slot_hour: editModal.newHour,
          pago_confirmado: slot.confirmedPay,
        })
      }
      setEditModal(null)
      ntf('Reserva actualizada. El pago se mantiene como estaba.')
      loadSlots(selectedDay)
    } catch (err) { ntf(err.message, 'err') }
  }

  function getSlot(courtId, hour) { return slots.find(s => s.court_id === courtId && s.hora === hour) }

  const canReserve = !!myChallenge

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="section-title" style={{ margin: 0 }}>Canchas</span>
        <span className={`badge ${canReserve ? 'badge-teal' : 'badge-gray'}`}>{canReserve ? 'Tienes desafío activo' : 'Solo lectura'}</span>
      </div>

      {!canReserve && <div className="notif notif-warn" style={{ marginBottom: 10 }}><i className="ti ti-info-circle" aria-hidden="true" /> Solo puedes reservar si tienes un desafío aceptado sin cancha asignada.</div>}

      {/* Date picker */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 4 }}>
        {days.map(d => (
          <button key={d.label} className={`btn ${selectedDay === d.label ? 'btn-accept' : ''}`}
            style={{ fontSize: 12, padding: '5px 12px', whiteSpace: 'nowrap', flexShrink: 0 }}
            onClick={() => setSelectedDay(d.label)}>
            {d.label}
          </button>
        ))}
      </div>

      {loading ? <p style={{ color: '#888', fontSize: 13, padding: 16 }}>Cargando...</p> : courts.map(court => (
        <div key={court.id} className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 6, background: court.surface === 'arcilla' ? '#FAEEDA' : '#E6F1FB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="ti ti-tennis" style={{ fontSize: 15, color: court.surface === 'arcilla' ? '#BA7517' : '#185FA5' }} aria-hidden="true" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{court.nombre}</div>
              <span className={`badge ${court.surface === 'arcilla' ? 'badge-amber' : 'badge-blue'}`}>{court.surface}</span>
            </div>
          </div>

          {HOURS.map(hour => {
            const slot = getSlot(court.id, hour)
            const isFree = !slot || slot.status === 'free'
            const isMySlot = slot?.reserved_by === player?.id
            const statusLabel = isFree ? 'Disponible · $8.000 pp' : slot?.status === 'confirmed' ? 'Confirmada' : slot?.status === 'pending_pay' ? 'Pago pendiente' : 'Reservada'
            const statusColor = isFree ? '#888' : slot?.status === 'confirmed' ? '#3B6D11' : '#633806'

            return (
              <div key={hour} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, border: '0.5px solid #e0dfd8', marginBottom: 4, background: isFree ? '#fff' : slot?.status === 'confirmed' ? '#EAF3DE' : '#FAEEDA', opacity: !isFree && !isMySlot ? 0.7 : 1 }}>
                <span style={{ fontSize: 13, fontWeight: 500, width: 48 }}>{hour}</span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: court.surface === 'arcilla' ? '#BA7517' : '#378ADD', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: statusColor }}>{statusLabel}</span>
                {isMySlot && <span className="badge badge-teal">tuya</span>}
                {isMySlot && <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setEditModal({ slot: { ...slot, confirmedPay: slot.status === 'confirmed' }, newCourt: court.id, newDay: selectedDay, newHour: hour, courts })}>Editar</button>}
                {isFree && canReserve && !isAdminCanchas && <button className="btn btn-accept" style={{ fontSize: 12, padding: '3px 10px' }} onClick={() => setModal({ courtId: court.id, courtName: court.nombre, surface: court.surface, day: selectedDay, hour })}>Reservar</button>}
                {isFree && isAdminCanchas && (
                  <>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', borderColor: '#A32D2D', color: '#A32D2D' }} onClick={() => setBlockModal({ courtId: court.id, hour })}>Bloquear</button>
                    {allChallenges.length > 0 && <button className="btn btn-accept" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setAssignModal({ courtId: court.id, hour, importChallenge: allChallenges[0] })}>Asignar</button>}
                  </>
                )}
                {!isFree && !isMySlot && isAdminCanchas && slot?.status !== 'confirmed' && <button className="btn btn-accept" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => confirmPayment(slot)}>✓ Pago</button>}
                {!isFree && isAdminCanchas && <button className="btn" style={{ fontSize: 11, padding: '2px 8px', borderColor: '#A32D2D', color: '#A32D2D' }} onClick={() => unblockSlot(slot)}>Liberar</button>}
                {!isFree && !isMySlot && !isAdminCanchas && <span className={`badge ${slot?.status === 'confirmed' ? 'badge-green' : 'badge-amber'}`}>{slot?.status === 'confirmed' ? 'confirmada' : 'ocupada'}</span>}
              </div>
            )
          })}
        </div>
      ))}

      {/* Modal reservar */}
      {modal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setModal(null) }}>
          <div className="modal">
            <h3>Reservar {modal.courtName}</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>{modal.day} · {modal.hour} · {modal.surface} · $8.000 pp</p>
            {myChallenge && (
              <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '8px 10px', fontSize: 12, marginBottom: 12 }}>
                <i className="ti ti-link" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                Partido vs <strong>{myChallenge.challenger_id === player.id ? `${myChallenge.challenged?.nombre} ${myChallenge.challenged?.apellido}` : `${myChallenge.challenger?.nombre} ${myChallenge.challenger?.apellido}`}</strong>
              </div>
            )}
            <p style={{ fontSize: 13, color: '#888' }}>Tienes 24 h para coordinar el pago con el admin.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={handleReserve}>Confirmar reserva</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal bloquear horario */}
      {blockModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setBlockModal(null) }}>
          <div className="modal">
            <h3>Bloquear horario</h3>
            <p style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>Se bloqueará el slot de {blockModal.hour} (30 min) en esta cancha.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setBlockModal(null)}>Cancelar</button>
              <button className="btn btn-reject" onClick={blockSlot}>Bloquear</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal asignar desafío */}
      {assignModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setAssignModal(null) }}>
          <div className="modal">
            <h3>Asignar cancha a desafío</h3>
            <div className="form-row"><label>Desafío</label>
              <select value={assignModal.importChallenge?.id} onChange={e => setAssignModal(m => ({ ...m, importChallenge: allChallenges.find(c => c.id === e.target.value) }))}>
                {allChallenges.map(c => <option key={c.id} value={c.id}>{c.challenger?.nombre} vs {c.challenged?.nombre}</option>)}
              </select>
            </div>
            <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>Se asignará {assignModal.hour} y bloquea 1.5 horas en esta cancha.</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setAssignModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={assignToChallengeSlot}>Asignar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar reserva */}
      {editModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditModal(null) }}>
          <div className="modal">
            <h3>Editar reserva</h3>
            {editModal.slot.confirmedPay && (
              <div className="notif notif-ok" style={{ marginBottom: 10 }}>
                <i className="ti ti-check" aria-hidden="true" /> Pago confirmado — se mantendrá al editar
              </div>
            )}
            <div className="form-row">
              <label>Cancha</label>
              <select value={editModal.newCourt} onChange={e => setEditModal(m => ({ ...m, newCourt: e.target.value }))}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.surface})</option>)}
              </select>
            </div>
            <div className="form-row">
              <label>Día</label>
              <select value={editModal.newDay} onChange={e => setEditModal(m => ({ ...m, newDay: e.target.value }))}>
                {days.map(d => <option key={d.label} value={d.label}>{d.label}</option>)}
              </select>
            </div>
            <div className="form-row">
              <label>Hora</label>
              <select value={editModal.newHour} onChange={e => setEditModal(m => ({ ...m, newHour: e.target.value }))}>
                {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditModal(null)}>Cancelar</button>
              <button className="btn btn-accept" onClick={handleEdit}>Guardar cambios</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
