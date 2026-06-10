import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, getPlayers } from '../lib/supabase'
import { notifyResult } from '../lib/notify'
import { useSession } from '../components/SessionContext'
import { supabase } from '../lib/supabase'

function fmtDate(d) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }) }
  catch { return d }
}


function hasMatchStarted(c) {
  if (!c.slot_day || !c.slot_hour) return false
  try {
    const d = c.slot_day
    if (d.length === 10 && d.includes('-')) {
      const [year, month, day] = d.split('-')
      const [hour, min] = c.slot_hour.split(':')
      return new Date() >= new Date(year, month - 1, day, hour, min)
    }
    return true
  } catch { return true }
}

function courtDot(courtId) {
  const isHard = courtId === 'c3'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: isHard ? '#60B8E0' : '#E8712A',
    marginRight: 4, flexShrink: 0, verticalAlign: 'middle'
  }} title={isHard ? 'Cancha dura' : 'Arcilla'} />
}

export default function Resultados() {
  const { player, updateSession } = useSession()
  const [challenges, setChallenges] = useState([])
  const [players, setPlayers] = useState([])
  const [scores, setScores] = useState({})
  const [tiebreaks, setTiebreaks] = useState({})
  const [editScores, setEditScores] = useState({})
  const [editTiebreaks, setEditTiebreaks] = useState({})
  const [editingId, setEditingId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [ch, pl] = await Promise.all([getChallenges(), getPlayers()])
      setChallenges(ch); setPlayers(pl)
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  // Partido listo para anotar: aceptado, cancha y pago confirmado
  // El jugador puede anotar si es parte del partido
  function canReport(c) {
    if (c.status !== 'accepted') return false
    if (!c.pago_confirmado) return false
    if (!(c.challenger_id === player?.id || c.challenged_id === player?.id)) return false
    return hasMatchStarted(c)
  }

  function isMyMatch(c) {
    return c.challenger_id === player?.id || c.challenged_id === player?.id
  }

  function canEdit(c) {
    if (c.status !== 'completed') return false
    if (!isMyMatch(c)) return false
    if (c.resultado_validado) return false
    // Solo el rival (no quien anotó) puede editar
    return c.anotado_por !== player?.id
  }

  function canValidate(c) {
    if (c.status !== 'completed') return false
    if (!isMyMatch(c)) return false
    if (c.resultado_validado) return false
    if (c.validado_por === player?.id) return false // ya validó
    return true
  }

  async function validateResult(c) {
    try {
      const alreadyValidated = c.validado_por !== null
      await import('../lib/supabase').then(m => m.updateChallenge(c.id, {
        validado_por: player.id,
        resultado_validado: alreadyValidated ? true : false // definitivo si el otro ya validó
      }))
      // Si el anotador valida o el rival valida → definitivo
      await import('../lib/supabase').then(async m => {
        const { data } = await supabase.from('challenges').select('validado_por, anotado_por').eq('id', c.id).single()
        if (data?.validado_por) {
          await m.updateChallenge(c.id, { resultado_validado: true })
        }
      })
      ntf('Resultado validado.')
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  async function saveEdit(c) {
    const sa = parseInt(editScores[c.id + "_a"] ?? c.score_a)
    const sb = parseInt(editScores[c.id + "_b"] ?? c.score_b)
    if (isNaN(sa) || isNaN(sb) || sa === sb) { ntf("Resultado inválido.", "err"); return }
    const isTB = (sa === 9 && sb === 8) || (sa === 8 && sb === 9)
    let tbA = null, tbB = null
    if (isTB) {
      tbA = parseInt(editTiebreaks[c.id + "_a"] ?? c.tiebreak_a)
      tbB = parseInt(editTiebreaks[c.id + "_b"] ?? c.tiebreak_b)
      if (isNaN(tbA) || isNaN(tbB) || Math.abs(tbA - tbB) < 2) { ntf("Tiebreak inválido.", "err"); return }
    }
    try {
      await updateChallenge(c.id, {
        score_a: sa, score_b: sb, ganador: sa > sb ? "challenger" : "challenged",
        tiebreak_a: isTB ? tbA : null, tiebreak_b: isTB ? tbB : null,
        anotado_por: player.id, // quien editó ahora es el anotador
        validado_por: null, resultado_validado: false
      })
      setEditingId(null)
      ntf("Resultado editado. El rival puede validarlo o editarlo.")
      load()
    } catch (err) { ntf(err.message, "err") }
  }

  async function saveResult(c) {
    const sa = parseInt(scores[c.id + '_a'] || '')
    const sb = parseInt(scores[c.id + '_b'] || '')
    if (isNaN(sa) || isNaN(sb)) { ntf('Ingresa los games de ambos.', 'err'); return }
    if (sa < 0 || sb < 0 || sa > 9 || sb > 9) { ntf('Games entre 0 y 9.', 'err'); return }
    if (sa === sb) { ntf('No puede terminar empatado.', 'err'); return }

    // Tiebreak si 9-8 o 8-9
    const isTB = (sa === 9 && sb === 8) || (sa === 8 && sb === 9)
    let tbA = null, tbB = null
    if (isTB) {
      tbA = parseInt(tiebreaks[c.id + '_a'] || '')
      tbB = parseInt(tiebreaks[c.id + '_b'] || '')
      if (isNaN(tbA) || isNaN(tbB)) { ntf('Ingresa el resultado del tiebreak.', 'err'); return }
      if (Math.abs(tbA - tbB) < 2) { ntf('Tiebreak: diferencia mínima de 2.', 'err'); return }
    }

    const winner = sa > sb ? 'challenger' : 'challenged'
    const winnerP = winner === 'challenger' ? c.challenger : c.challenged
    const loserP = winner === 'challenger' ? c.challenged : c.challenger
    const winnerFull = players.find(p => p.id === winnerP?.id)
    const loserFull = players.find(p => p.id === loserP?.id)

    try {
      // Guardar resultado — NO mover ranking, espera al jueves
      await updateChallenge(c.id, {
        status: 'completed', score_a: sa, score_b: sb, ganador: winner,
        anotado_por: player.id, validado_por: null, resultado_validado: false,
        ...(isTB ? { tiebreak_a: tbA, tiebreak_b: tbB } : {})
      })
      // Solo actualizar victorias/derrotas
      if (winnerFull) await import('../lib/supabase').then(m => m.updatePlayer(winnerFull.id, { victorias: (winnerFull.victorias || 0) + 1 }))
      if (loserFull) await import('../lib/supabase').then(m => m.updatePlayer(loserFull.id, { derrotas: (loserFull.derrotas || 0) + 1 }))

      await notifyResult(c.challenger, c.challenged, sa, sb, winnerP, null)
      // Refrescar sesión del jugador actual
      const { data: freshPlayer } = await supabase.from('players').select('*').eq('id', player.id).single()
      if (freshPlayer) updateSession(freshPlayer)
      ntf(`Resultado guardado: ${sa}–${sb}${isTB ? ` (${tbA}–${tbB})` : ''}. El ranking se actualiza el jueves.`)
      load()
    } catch (err) { ntf(err.message, 'err') }
  }

  const toReport = challenges.filter(c => canReport(c))
  const completed = challenges.filter(c => c.status === 'completed')

  if (loading) return <p style={{ color: '#888', fontSize: 13, padding: 24 }}>Cargando...</p>

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      {toReport.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">Anotar resultado</div>
          {toReport.map(c => {
            const sa = scores[c.id + '_a'] || ''
            const sb = scores[c.id + '_b'] || ''
            const isTB = (parseInt(sa) === 9 && parseInt(sb) === 8) || (parseInt(sa) === 8 && parseInt(sb) === 9)
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
                    <input type="number" min="0" max="9" placeholder="0-9" value={sa} onChange={e => setScores(s => ({ ...s, [c.id + '_a']: e.target.value }))} />
                  </div>
                  <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenged?.nombre}</label>
                    <input type="number" min="0" max="9" placeholder="0-9" value={sb} onChange={e => setScores(s => ({ ...s, [c.id + '_b']: e.target.value }))} />
                  </div>
                  <button className="btn btn-accept" style={{ marginBottom: 1 }} onClick={() => saveResult(c)}>Guardar</button>
                </div>

                {isTB && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: '#FAEEDA', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 8 }}>
                      <i className="ti ti-trophy" style={{ verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
                      Resultado 9-8 — ingresa el tiebreak
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
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

      {toReport.length === 0 && (
        <div className="notif" style={{ background: '#f5f4f0', border: '0.5px solid #e0dfd8', marginBottom: 14 }}>
          <i className="ti ti-info-circle" aria-hidden="true" />
          No hay partidos listos para anotar. La cancha debe estar reservada y con pago confirmado.
        </div>
      )}

      <div className="section-title">Historial</div>
      <div className="card">
        {completed.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin partidos jugados aún</p>
          : (() => {
            const active = completed.filter(c => c.ranking_applied === false)
            const historic = completed.filter(c => c.ranking_applied === true || c.ranking_applied === null)
            const renderRow = (c) => {
              const w = c.ganador === 'challenger' ? c.challenger : c.challenged
              const hasTB = c.tiebreak_a != null && c.tiebreak_b != null
              const isEditing = editingId === c.id
              const esa = editScores[c.id + '_a'] ?? c.score_a
              const esb = editScores[c.id + '_b'] ?? c.score_b
              const editIsTB = (parseInt(esa) === 9 && parseInt(esb) === 8) || (parseInt(esa) === 8 && parseInt(esb) === 9)
              return (
                <div key={c.id}>
                  <div className="row-item">
                    <span style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{c.challenger?.nombre}</span>
                      <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>
                        {c.score_a}–{c.score_b}{hasTB ? ` (${c.tiebreak_a}–${c.tiebreak_b})` : ''}{c.is_wo ? ' (WO)' : ''}
                      </span>
                      <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{c.challenged?.nombre}</span>
                    </span>
                    {c.resultado_validado && <span className="badge badge-green" style={{ fontSize: 10, flexShrink: 0 }}>✓</span>}
                    <span className="badge badge-green" style={{ flexShrink: 0 }}>{w?.nombre}</span>
                    {c.slot_court && <span style={{ marginLeft: 4 }}>{courtDot(c.slot_court)}</span>}
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 4, flexShrink: 0 }}>{fmtDate(c.created_at)}</span>
                    {canValidate(c) && !isEditing && (
                      <button className="btn btn-accept" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 4 }}
                        onClick={() => validateResult(c)}>
                        Validar
                      </button>
                    )}
                    {canEdit(c) && !isEditing && (
                      <button className="btn" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 2 }}
                        onClick={() => { setEditingId(c.id); setEditScores({ [c.id + '_a']: c.score_a, [c.id + '_b']: c.score_b }); setEditTiebreaks({ [c.id + '_a']: c.tiebreak_a || '', [c.id + '_b']: c.tiebreak_b || '' }) }}>
                        Editar
                      </button>
                    )}
                  </div>
                  {isEditing && (
                    <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Corregir resultado</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenger?.nombre}</label><input type="number" min="0" max="9" value={esa} onChange={e => setEditScores(s => ({ ...s, [c.id + '_a']: e.target.value }))} /></div>
                        <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
                        <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenged?.nombre}</label><input type="number" min="0" max="9" value={esb} onChange={e => setEditScores(s => ({ ...s, [c.id + '_b']: e.target.value }))} /></div>
                      </div>
                      {editIsTB && (
                        <div style={{ marginTop: 8, padding: '8px 10px', background: '#FAEEDA', borderRadius: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 6 }}>Tiebreak 9-8</div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenger?.nombre}</label><input type="number" min="0" value={editTiebreaks[c.id + '_a'] || ''} onChange={e => setEditTiebreaks(t => ({ ...t, [c.id + '_a']: e.target.value }))} /></div>
                            <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
                            <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{c.challenged?.nombre}</label><input type="number" min="0" value={editTiebreaks[c.id + '_b'] || ''} onChange={e => setEditTiebreaks(t => ({ ...t, [c.id + '_b']: e.target.value }))} /></div>
                          </div>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                        <button className="btn" style={{ fontSize: 12 }} onClick={() => setEditingId(null)}>Cancelar</button>
                        <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => saveEdit(c)}>Guardar</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            return (
              <>
                {active.map(renderRow)}
                {active.length > 0 && historic.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', color: '#aaa' }}>
                    <div style={{ flex: 1, height: '0.5px', background: '#e0dfd8' }} />
                    <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>Historial anterior</span>
                    <div style={{ flex: 1, height: '0.5px', background: '#e0dfd8' }} />
                  </div>
                )}
                {historic.map(renderRow)}
              </>
            )
          })()
        }
      </div>
    </div>
  )
}