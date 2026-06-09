import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, updatePlayer, getPlayers } from '../lib/supabase'
import { notifyResult } from '../lib/notify'
import { useSession } from '../components/SessionContext'

export default function Resultados() {
  const { player } = useSession()
  const [challenges, setChallenges] = useState([])
  const [players, setPlayers] = useState([])
  const [scores, setScores] = useState({})
  const [tiebreaks, setTiebreaks] = useState({})
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [ch, pl] = await Promise.all([getChallenges(), getPlayers()])
      setChallenges(ch)
      setPlayers(pl)
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  async function saveResult(c) {
    const sa = parseInt(scores[c.id + '_a'] || '')
    const sb = parseInt(scores[c.id + '_b'] || '')
    if (isNaN(sa) || isNaN(sb)) { ntf('Ingresa los games de ambos.', 'err'); return }
    if (sa === sb && !(sa === 8 && sb === 8)) { ntf('Resultado inválido.', 'err'); return }
    if (sa < 0 || sb < 0 || sa > 9 || sb > 9) { ntf('Games entre 0 y 9.', 'err'); return }

    // Tiebreak si 8-8
    let tbA = null, tbB = null
    if (sa === 8 && sb === 8) {
      tbA = parseInt(tiebreaks[c.id + '_a'] || '')
      tbB = parseInt(tiebreaks[c.id + '_b'] || '')
      if (isNaN(tbA) || isNaN(tbB)) { ntf('Ingresa el resultado del tiebreak.', 'err'); return }
      if (Math.abs(tbA - tbB) < 2) { ntf('El tiebreak debe ganarse por diferencia de 2.', 'err'); return }
    }

    const winner = sa === 8 && sb === 8 ? (tbA > tbB ? 'challenger' : 'challenged') : (sa > sb ? 'challenger' : 'challenged')
    const winnerPlayer = winner === 'challenger' ? c.challenger : c.challenged
    const loserPlayer = winner === 'challenger' ? c.challenged : c.challenger
    const winnerFull = players.find(p => p.id === winnerPlayer?.id)
    const loserFull = players.find(p => p.id === loserPlayer?.id)

    try {
      await updateChallenge(c.id, {
        status: 'completed', score_a: sa, score_b: sb, ganador: winner,
        ...(tbA !== null ? { tiebreak_a: tbA, tiebreak_b: tbB } : {})
      })
      if (winnerFull) await updatePlayer(winnerFull.id, { victorias: (winnerFull.victorias || 0) + 1 })
      if (loserFull) await updatePlayer(loserFull.id, { derrotas: (loserFull.derrotas || 0) + 1 })

      let newPos = null
      if (winner === 'challenger' && winnerFull && loserFull && winnerFull.posicion > loserFull.posicion) {
        const wp = winnerFull.posicion, lp = loserFull.posicion
        newPos = lp
        for (const p of players) {
          if (p.posicion >= lp && p.posicion < wp) await updatePlayer(p.id, { posicion_anterior: p.posicion, posicion: p.posicion + 1 })
        }
        await updatePlayer(winnerFull.id, { posicion_anterior: winnerFull.posicion, posicion: lp })
      }

      if (winnerPlayer && loserPlayer) await notifyResult(c.challenger, c.challenged, sa, sb, winnerPlayer, newPos)
      ntf(`Resultado guardado: ${sa}–${sb}${tbA !== null ? ` (TB: ${tbA}–${tbB})` : ''}`)
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  const toReport = challenges.filter(c =>
    (c.challenger_id === player?.id || c.challenged_id === player?.id) &&
    c.status === 'accepted' && c.slot_day && c.pago_confirmado
  )
  const completed = challenges.filter(c => c.status === 'completed')

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      {toReport.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">Anotar resultado</div>
          {toReport.map(c => {
            const isTie = parseInt(scores[c.id + '_a']) === 8 && parseInt(scores[c.id + '_b']) === 8
            return (
              <div key={c.id} className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.challenger?.nombre} {c.challenger?.apellido}</span>
                  <span style={{ color: '#888' }}>vs</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.challenged?.nombre} {c.challenged?.apellido}</span>
                  {c.slot_court && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>{c.slot_court} · {c.slot_hour}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenger?.nombre}</label>
                    <input type="number" min="0" max="9" placeholder="0-9" value={scores[c.id + '_a'] || ''} onChange={e => setScores(s => ({ ...s, [c.id + '_a']: e.target.value }))} />
                  </div>
                  <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenged?.nombre}</label>
                    <input type="number" min="0" max="9" placeholder="0-9" value={scores[c.id + '_b'] || ''} onChange={e => setScores(s => ({ ...s, [c.id + '_b']: e.target.value }))} />
                  </div>
                  <button className="btn btn-accept" style={{ marginBottom: 1 }} onClick={() => saveResult(c)}>Guardar</button>
                </div>
                {isTie && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: '#FAEEDA', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 8 }}>
                      <i className="ti ti-trophy" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                      Empate 8-8 — Resultado del Tie-break
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenger?.nombre}</label>
                        <input type="number" min="0" placeholder="TB" value={tiebreaks[c.id + '_a'] || ''} onChange={e => setTiebreaks(t => ({ ...t, [c.id + '_a']: e.target.value }))} />
                      </div>
                      <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenged?.nombre}</label>
                        <input type="number" min="0" placeholder="TB" value={tiebreaks[c.id + '_b'] || ''} onChange={e => setTiebreaks(t => ({ ...t, [c.id + '_b']: e.target.value }))} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {toReport.length === 0 && <p style={{ fontSize: 13, color: '#888', marginBottom: 14 }}>No hay partidos listos para anotar.</p>}

      <div className="section-title">Historial</div>
      <div className="card">
        {completed.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin partidos jugados aún</p>
          : completed.map(c => {
            const w = c.ganador === 'challenger' ? c.challenger : c.challenged
            const hasTB = c.tiebreak_a !== null && c.tiebreak_b !== null
            return (
              <div key={c.id} className="row-item">
                <span style={{ flex: 1, fontSize: 13 }}>
                  <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{c.challenger?.nombre} {c.challenger?.apellido}</span>
                  <span style={{ color: '#888', fontSize: 12, margin: '0 6px' }}>
                    {c.score_a}–{c.score_b}{hasTB ? ` (TB ${c.tiebreak_a}–${c.tiebreak_b})` : ''}
                  </span>
                  <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{c.challenged?.nombre} {c.challenged?.apellido}</span>
                </span>
                <span className="badge badge-green">{w?.nombre}</span>
              </div>
            )
          })
        }
      </div>
    </div>
  )
}
