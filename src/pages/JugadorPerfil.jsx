import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, getChallenges } from '../lib/supabase'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function JugadorPerfil() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [jugador, setJugador] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [id])

  async function load() {
    try {
      const [{ data: j }, ch] = await Promise.all([
        supabase.from('players').select('*').eq('id', id).single(),
        getChallenges()
      ])
      setJugador(j)
      const mine = ch.filter(c => (c.challenger_id === id || c.challenged_id === id) && c.status === 'completed')
      setHistory(mine)
    } finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>
  if (!jugador) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Jugador no encontrado</p>

  const wins = history.filter(c => (c.ganador === 'challenger' && c.challenger_id === id) || (c.ganador === 'challenged' && c.challenged_id === id))

  return (
    <div>
      <button className="btn" style={{ fontSize: 12, marginBottom: 12 }} onClick={() => navigate(-1)}>
        <i className="ti ti-arrow-left" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Volver
      </button>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <div className="avatar" style={{ width: 52, height: 52, fontSize: 18, background: jugador.lesionado ? '#FCEBEB' : '#E1F5EE', color: jugador.lesionado ? '#A32D2D' : '#0F6E56' }}>
          {ini(jugador.nombre, jugador.apellido)}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{jugador.nombre} {jugador.apellido}</div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>#{jugador.posicion} en el ranking</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>{wins.length}V {history.length - wins.length}D · {history.length} partidos</div>
          {jugador.lesionado && <span className="badge badge-red" style={{ fontSize: 10, marginTop: 4, display: 'inline-block' }}>Lesionado{jugador.lesion_nota ? ` — ${jugador.lesion_nota}` : ''}</span>}
        </div>
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        Historial de partidos
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
            return (
              <div key={c.id} className="row-item">
                <span className={`badge ${won ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0 }}>{won ? 'W' : 'L'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>vs {rival?.nombre} {rival?.apellido}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{myScore}–{rivalScore}</span>
                {c.slot_court && <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{c.slot_court}</span>}
                {c.created_at && <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{new Date(c.created_at).toLocaleDateString('es-CL')}</span>}
              </div>
            )
          })
        }
      </div>
    </div>
  )
}