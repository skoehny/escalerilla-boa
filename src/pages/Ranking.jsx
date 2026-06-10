import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPlayers, createChallenge, getChallenges, supabase } from '../lib/supabase'
import { notifyChallengeSent } from '../lib/notify'
import { useSession } from '../components/SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }
function trend(pos, prev) {
  if (!prev || pos === prev) return <span style={{ color: '#888', fontSize: 11 }}>—</span>
  const d = prev - pos
  if (d > 0) return <span style={{ color: '#3B6D11', fontSize: 11 }}>↑{d}</span>
  return <span style={{ color: '#A32D2D', fontSize: 11 }}>↓{Math.abs(d)}</span>
}

export default function Ranking() {
  const { player, updateSession } = useSession()
  const navigate = useNavigate()
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [hasActive, setHasActive] = useState(false)
  const [challenges, setChallenges] = useState([])
  const [myStats, setMyStats] = useState({ wins: 0, losses: 0 })
  const [playedThisWeek, setPlayedThisWeek] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [pl, ch] = await Promise.all([getPlayers(), getChallenges()])
      setPlayers(pl)
      const active = ch.some(c =>
        (c.challenger_id === player?.id || c.challenged_id === player?.id) &&
        (c.status === 'pending' || c.status === 'accepted' ||
         (c.status === 'completed' && c.ranking_applied === false))
      )
      setChallenges(ch)
      setHasActive(active)
      // Calcular wins/losses desde historial
      const completed = ch.filter(c => c.status === 'completed')
      const wins = completed.filter(c =>
        (c.ganador === 'challenger' && c.challenger_id === player?.id) ||
        (c.ganador === 'challenged' && c.challenged_id === player?.id)
      ).length
      const losses = completed.filter(c =>
        (c.ganador === 'challenger' && c.challenged_id === player?.id) ||
        (c.ganador === 'challenged' && c.challenger_id === player?.id)
      ).length
      setMyStats({ wins, losses })
      setPlayedThisWeek(active)
      // Refrescar sesión con datos actualizados
      if (player?.id) {
        const { data: fresh } = await supabase.from('players').select('*').eq('id', player.id).single()
        if (fresh) updateSession(fresh)
      }
    } finally { setLoading(false) }
  }

  function notify(msg, type = 'ok') {
    setNotif({ msg, type })
    setTimeout(() => setNotif(null), 4000)
  }

  async function handleChallenge(target, isWildcard = false) {
    try {
      const d = new Date()
      while (d.getDay() !== 3) d.setDate(d.getDate() + 1)
      const deadline = d.toISOString().split('T')[0]
      await createChallenge({ challenger_id: player.id, challenged_id: target.id, deadline, is_wildcard: isWildcard })
      if (isWildcard) {
        await supabase.from('players').update({ wildcard_usada: true }).eq('id', player.id)
        updateSession({ ...player, wildcard_usada: true })
      }
      await notifyChallengeSent(player, target)
      const waText = `🎾 *Escalerilla BOA*\n\n⚔️ ${player.nombre} ${player.apellido} desafía a ${target.nombre} ${target.apellido}${isWildcard ? ' (Wild Card 🌟)' : ''}\n\nVer desafíos: https://escalerilla-boa.vercel.app`
      window.open(`https://wa.me/?text=${encodeURIComponent(waText)}`, '_blank')
      notify(`${isWildcard ? '⭐ Wild Card usada — ' : ''}Desafío enviado a ${target.nombre} ${target.apellido}.`)
      load()
    } catch (err) { notify(err.message, 'err') }
  }

  if (loading) return <p style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 24 }}>Cargando ranking...</p>

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      <div className="week-banner">
        <span><i className="ti ti-calendar" style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />Semana activa · cierre mié · actualización jueves</span>
        <span className="badge badge-teal">1 partido disponible</span>
      </div>

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-val">#{player?.posicion || '—'}</div><div className="stat-label">Mi posición</div></div>
        <div className="stat-card"><div className="stat-val">{player?.victorias || 0}</div><div className="stat-label">Victorias</div></div>
        <div className="stat-card"><div className="stat-val">{player?.derrotas || 0}</div><div className="stat-label">Derrotas</div></div>
        <div className="stat-card"><div className="stat-val">{players.length}</div><div className="stat-label">Activos</div></div>
      </div>

      {player?.lesionado && (
        <div className="notif notif-err" style={{ marginBottom: 10 }}>
          <i className="ti ti-first-aid-kit" aria-hidden="true" /> Estás marcado como lesionado{player.lesion_nota ? ` — ${player.lesion_nota}` : ''}. No puedes recibir desafíos.
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span className="section-title" style={{ margin: 0 }}>Ranking</span>
          <span style={{ fontSize: 11, color: '#888' }}>Actualizado este jueves</span>
        </div>

        {players.map(p => {
          const isMe = p.id === player?.id
          const numColor = p.posicion === 1 ? '#BA7517' : p.posicion === 2 ? '#888780' : p.posicion === 3 ? '#D85A30' : '#888'
          // Check if target player has active challenge or played this week
          const targetHasActive = challenges.some(c =>
            (c.challenger_id === p.id || c.challenged_id === p.id) &&
            (c.status === 'pending' || c.status === 'accepted' ||
             (c.status === 'completed' && c.ranking_applied === false))
          )
          const canChallenge = !isMe && p.posicion < player?.posicion && p.posicion >= player?.posicion - 3 && !p.lesionado && !player?.lesionado && !hasActive && !targetHasActive && !playedThisWeek

          return (
            <div key={p.id} className="row-item" style={isMe ? { background: '#f5f4f0', borderRadius: 8, padding: '8px', margin: '0 -6px' } : {}}>
              <span style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 500, color: numColor, flexShrink: 0 }}>{p.posicion}</span>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 10, background: p.lesionado ? '#FCEBEB' : '#E1F5EE', color: p.lesionado ? '#A32D2D' : '#0F6E56', cursor: 'pointer' }}
                onClick={() => navigate(`/jugador/${p.id}`)}>
                {ini(p.nombre, p.apellido)}
              </div>
              <span style={{ flex: 1, fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/jugador/${p.id}`)}>
                {p.nombre} {p.apellido}
                {isMe && <span style={{ fontSize: 11, color: '#1D9E75', marginLeft: 4 }}>(tú)</span>}
                {p.lesionado && <span className="badge badge-red" style={{ fontSize: 10, marginLeft: 4 }}>lesionado</span>}
              </span>
              <span style={{ fontSize: 12, color: '#888' }}>{p.victorias || 0}V {p.derrotas || 0}D</span>
              <span style={{ width: 24, textAlign: 'center' }}>{trend(p.posicion, p.posicion_anterior)}</span>
              {canChallenge && (
                <button className="btn btn-accept" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => handleChallenge(p)}>
                  Desafiar
                </button>
              )}
              {!canChallenge && !isMe && !hasActive && !player?.lesionado && !p.lesionado && !targetHasActive
                && !player?.wildcard_usada && p.posicion < player?.posicion
                && !playedThisWeek && (
                <button className="btn btn-warn" style={{ padding: '3px 10px', fontSize: 12 }}
                  onClick={() => {
                    if (window.confirm(`¿Usar tu Wild Card para desafiar a ${p.nombre} ${p.apellido} (#${p.posicion})? Solo tienes 1 por año.`)) {
                      handleChallenge(p, true)
                    }
                  }}>
                  Wild Card
                </button>
              )}
            </div>
          )
        })}
      </div>
      {hasActive && <p style={{ fontSize: 12, color: '#888', textAlign: 'center' }}>Ya tienes un desafío activo esta semana</p>}
    </div>
  )
}