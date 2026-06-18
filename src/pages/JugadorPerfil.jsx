import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, getChallenges } from '../lib/supabase'
import { useSession } from '../components/SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

function inactivityTime(player, lastPlayedDate) {
  const referenceDate = lastPlayedDate || player?.ultima_fecha_jugada || player?.created_at
  if (!referenceDate) return null
  const now = new Date()
  const ref = new Date(referenceDate)
  const diffDays = Math.floor((now - ref) / (1000 * 60 * 60 * 24))
  if (diffDays < 7) return null
  const weeks = Math.floor(diffDays / 7)
  const days = diffDays % 7
  return `${weeks}S ${days}D`
}

function statusText(c) {
  if (!c) return ''
  if (c.status === 'pending') return 'Desafío pendiente de aceptación'
  if (c.status === 'accepted' && !c.slot_day) return 'Acordando día'
  if (c.status === 'accepted' && c.slot_day && !c.pago_confirmado) return `Cancha reservada · ${c.slot_day} ${c.slot_hour || ''}`
  if (c.status === 'accepted' && c.pago_confirmado) return `Listo para jugar · ${c.slot_day} ${c.slot_hour || ''}`
  if (c.status === 'completed') return `Jugado: ${c.score_a}–${c.score_b}`
  return ''
}

function fmtDate(d) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }) }
  catch { return d }
}

function courtDot(courtId) {
  const isHard = courtId === 'c3'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: isHard ? '#60B8E0' : '#E8712A',
    marginRight: 4, flexShrink: 0, verticalAlign: 'middle'
  }} title={isHard ? 'Cancha dura' : 'Arcilla'} />
}

export default function JugadorPerfil() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { player: me } = useSession()
  const [jugador, setJugador] = useState(null)
  const [history, setHistory] = useState([])
  const [activeChallenge, setActiveChallenge] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [id])

  async function load() {
    try {
      const [{ data: j }, ch] = await Promise.all([
        supabase.from('players').select('*').eq('id', id).single(),
        getChallenges()
      ])
      setJugador(j)
      const mine = ch.filter(c =>
        (c.challenger_id === id || c.challenged_id === id) && c.status === 'completed'
      ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      setHistory(mine)
      const active = ch.find(c =>
        (c.challenger_id === id || c.challenged_id === id) &&
        (c.status === 'pending' || c.status === 'accepted' ||
         (c.status === 'completed' && c.ranking_applied === false))
      )
      setActiveChallenge(active || null)
    } finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>
  if (!jugador) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Jugador no encontrado</p>

  const wins = history.filter(c =>
    (c.ganador === 'challenger' && c.challenger_id === id) ||
    (c.ganador === 'challenged' && c.challenged_id === id)
  )

  // Head to head con el jugador logueado
  const isMe = me?.id === id
  const h2h = history.filter(c =>
    (c.challenger_id === id && c.challenged_id === me?.id) ||
    (c.challenged_id === id && c.challenger_id === me?.id)
  )
  const h2hWinsMe = h2h.filter(c =>
    (c.ganador === 'challenger' && c.challenger_id === me?.id) ||
    (c.ganador === 'challenged' && c.challenged_id === me?.id)
  ).length
  const h2hWinsRival = h2h.length - h2hWinsMe

  return (
    <div>
      <button className="btn" style={{ fontSize: 12, marginBottom: 12 }} onClick={() => navigate(-1)}>
        <i className="ti ti-arrow-left" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Volver
      </button>

      {/* Perfil */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <div className="avatar" style={{
          width: 52, height: 52, fontSize: 18,
          background: jugador.lesionado ? '#FCEBEB' : '#E1F5EE',
          color: jugador.lesionado ? '#A32D2D' : '#0F6E56'
        }}>
          {ini(jugador.nombre, jugador.apellido)}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{jugador.nombre} {jugador.apellido}</div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>#{jugador.posicion} en el ranking</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>
            {wins.length}V {history.length - wins.length}D · {history.length} partidos
          </div>
          {(() => {
            const lastPlayed = history[0]?.created_at
            const inactTime = inactivityTime(jugador, lastPlayed)
            return (
              <>
                {jugador.lesionado && (
                  <span className="badge badge-red" style={{ fontSize: 10, marginTop: 4, display: 'inline-block' }}>
                    Lesionado{inactTime ? ` (${inactTime})` : ''}{jugador.lesion_nota ? ` — ${jugador.lesion_nota}` : ''}
                  </span>
                )}
                {!jugador.lesionado && inactTime && (
                  <span style={{ fontSize: 10, marginTop: 4, display: 'inline-block', color: '#888', background: '#f0efe8', padding: '2px 8px', borderRadius: 6 }}>
                    Inactividad ({inactTime})
                  </span>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* Estado actual de esta semana */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Esta semana</div>
        {activeChallenge ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: '#C5E635', color: '#fff', flexShrink: 0 }}>
              <i className="ti ti-check" style={{ fontSize: 10 }} aria-hidden="true" />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Tiene desafío activo</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                vs {activeChallenge.challenger_id === id ? `${activeChallenge.challenged?.nombre} ${activeChallenge.challenged?.apellido}` : `${activeChallenge.challenger?.nombre} ${activeChallenge.challenger?.apellido}`}
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{statusText(activeChallenge)}</div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#888' }}>
            <i className="ti ti-calendar-off" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
            Sin partido agendado esta semana
          </div>
        )}
      </div>

      {/* Head to head — solo si no es el mismo jugador */}
      {!isMe && h2h.length > 0 && (
        <div className="card" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>
            Head to head
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 10 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 500, color: h2hWinsMe > h2hWinsRival ? '#1D9E75' : '#888' }}>{h2hWinsMe}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{me?.nombre}</div>
            </div>
            <div style={{ fontSize: 14, color: '#ccc', fontWeight: 500 }}>—</div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 500, color: h2hWinsRival > h2hWinsMe ? '#1D9E75' : '#888' }}>{h2hWinsRival}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{jugador.nombre}</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#888', textAlign: 'center' }}>{h2h.length} partido{h2h.length !== 1 ? 's' : ''} jugados entre ambos</div>

          {/* Partidos h2h */}
          <div style={{ marginTop: 10 }}>
            {h2h.map(c => {
              const isChallenger = c.challenger_id === me?.id
              const myScore = isChallenger ? c.score_a : c.score_b
              const rivalScore = isChallenger ? c.score_b : c.score_a
              const won = (c.ganador === 'challenger' && isChallenger) || (c.ganador === 'challenged' && !isChallenger)
              const hasTB = c.tiebreak_a != null && c.tiebreak_b != null
              const tbMe = isChallenger ? c.tiebreak_a : c.tiebreak_b
              const tbRival = isChallenger ? c.tiebreak_b : c.tiebreak_a
              return (
                <div key={c.id} className="row-item">
                  <span className={`badge ${won ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0, width: 20, textAlign: 'center' }}>{won ? 'W' : 'L'}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
                    {myScore}–{rivalScore}{hasTB ? ` (${tbMe}–${tbRival})` : ''}{c.is_wo ? ' (WO)' : ''}
                  </span>
                  {c.slot_court && courtDot(c.slot_court)}
                  <span style={{ fontSize: 11, color: '#888' }}>{fmtDate(c.created_at)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Historial general */}
      <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        Historial de partidos
      </div>
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#888', marginBottom: 8, alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#E8712A' }} />
          Arcilla
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#60B8E0' }} />
          Cancha dura
        </span>
      </div>
      <div className="card">
        {history.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin partidos jugados aún</p>
          : history.map(c => {
            const isChallenger = c.challenger_id === id
            const won = (c.ganador === 'challenger' && isChallenger) || (c.ganador === 'challenged' && !isChallenger)
            const rival = isChallenger ? c.challenged : c.challenger
            const myScore = isChallenger ? c.score_a : c.score_b
            const rivalScore = isChallenger ? c.score_b : c.score_a
            const hasTB = c.tiebreak_a != null && c.tiebreak_b != null
            const tbMine = isChallenger ? c.tiebreak_a : c.tiebreak_b
            const tbRival = isChallenger ? c.tiebreak_b : c.tiebreak_a
            return (
              <div key={c.id} className="row-item">
                <span className={`badge ${won ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0, width: 20, textAlign: 'center' }}>{won ? 'W' : 'L'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>vs {rival?.nombre} {rival?.apellido}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {myScore}–{rivalScore}{hasTB ? ` (${tbMine}–${tbRival})` : ''}{c.is_wo ? ' (WO)' : ''}
                </span>
                {c.slot_court && courtDot(c.slot_court)}
                <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>{fmtDate(c.created_at)}</span>
              </div>
            )
          })
        }
      </div>
    </div>
  )
}