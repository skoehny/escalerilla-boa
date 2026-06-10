import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, supabase } from '../lib/supabase'

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

const WA_GROUP = 'https://chat.whatsapp.com/ECl8ws6EkfLKzKuycVrcRo'
const STEPS = ['Pendiente', 'Acordar día', 'Reservar cancha', 'Pago confirmado', 'Jugado']

function waMsg(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}

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
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const data = await getChallenges()
      setChallenges(data)
    } finally { setLoading(false) }
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

  async function cancelChallenge(c) {
    await updateChallenge(c.id, { status: 'expired' })
    ntf('Desafío cancelado. Ambos jugadores quedan libres.', 'warn')
    load()
  }

  const received = challenges.filter(c => c.challenged_id === player?.id && c.status === 'pending')
  const myActive = challenges.find(c =>
    (c.challenger_id === player?.id || c.challenged_id === player?.id) &&
    (c.status === 'pending' || c.status === 'accepted')
  )
  const allActive = challenges.filter(c => c.status === 'pending' || c.status === 'accepted')

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  return (
    <div>
      {notif && (
        <div className={`notif notif-${notif.type}`}>
          <i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" />
          {notif.msg}
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
                <button className="btn btn-accept" style={{ fontSize: 12, padding: '4px 10px' }} onClick={async () => { await accept(c); window.open(waMsg(`🎾 *Escalerilla BOA*\n\n✅ ${c.challenged?.nombre} aceptó el desafío de ${c.challenger?.nombre}\n\nVer desafíos: https://escalerilla-boa.vercel.app`), '_blank') }}>Aceptar</button>
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
                  <a href="/canchas" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '0.5px solid #ccc', color: '#333', fontSize: 12, textDecoration: 'none' }}>
                    Ver canchas disponibles →
                  </a>
                  <button className="btn btn-reject" style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={() => cancelChallenge(myActive)}>
                    Cancelar desafío
                  </button>
                </div>
              </div>
            )}

            {stepOf(myActive) >= 2 && myActive.slot_court && (
              <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '9px 12px', marginTop: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {myActive.slot_court} · {myActive.slot_day} · {myActive.slot_hour}
                </div>
                <div style={{ fontSize: 12, color: myActive.pago_confirmado ? '#3B6D11' : '#888', marginTop: 2 }}>
                  {myActive.pago_confirmado
                    ? <><i className="ti ti-check" aria-hidden="true" style={{ marginRight: 3 }} />Pago confirmado — listo para jugar</>
                    : 'Pago pendiente — el admin validará en breve'}
                </div>
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
                {c.deadline && <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>{fmtDate(c.deadline)}</span>}
              </div>
            )
          })
        }
      </div>

      <p style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
        <i className="ti ti-info-circle" style={{ verticalAlign: -2 }} aria-hidden="true" /> 48 h para aceptar · máx. 2 rechazos/mes · 1 partido/semana · lesionados no pueden ser desafiados
      </p>
    </div>
  )
}