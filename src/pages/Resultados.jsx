import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, getPlayers, supabase } from '../lib/supabase'
import { notifyResult } from '../lib/notify'
import { useSession } from '../components/SessionContext'

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
  const [slotInfo, setSlotInfo] = useState({}) // cancha/fecha/hora inline al anotar resultado
  const [editScores, setEditScores] = useState({})
  const [editTiebreaks, setEditTiebreaks] = useState({})
  const [editingId, setEditingId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [activeTab, setActiveTab] = useState('partidos')
  const [rankingHistory, setRankingHistory] = useState([])
  const [selectedWeekIdx, setSelectedWeekIdx] = useState(0)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [ch, pl] = await Promise.all([getChallenges(), getPlayers()])
      setChallenges(ch); setPlayers(pl)
      const { data: hist } = await supabase.from('ranking_history').select('*').order('semana', { ascending: false }).limit(20)
      setRankingHistory(hist || [])
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  // Partido listo para anotar: aceptado y es parte del partido
  // No requiere que haya pasado la hora ni que el pago esté confirmado
  // Pero saveResult exigirá cancha + fecha + hora + score antes de guardar
  function canReport(c) {
    if (c.status !== 'accepted') return false
    if (!(c.challenger_id === player?.id || c.challenged_id === player?.id)) return false
    return true
  }

  function isMyMatch(c) {
    return c.challenger_id === player?.id || c.challenged_id === player?.id
  }

  function canEdit(c) {
    if (c.status !== 'completed') return false
    if (!isMyMatch(c)) return false
    if (c.resultado_validado) return false
    if (c.ranking_applied) return false // historial bloqueado
    // Solo el rival (no quien anotó) puede editar
    return c.anotado_por !== player?.id
  }

  function canValidate(c) {
    if (c.status !== 'completed') return false
    if (!isMyMatch(c)) return false
    if (c.resultado_validado) return false
    if (c.ranking_applied) return false // historial bloqueado
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

  async function cancelResult(c) {
    if (!window.confirm('¿Cancelar el resultado? El partido vuelve a "jugando" y podrán ingresar el resultado de nuevo.')) return
    try {
      await updateChallenge(c.id, {
        status: 'accepted',
        score_a: null, score_b: null,
        tiebreak_a: null, tiebreak_b: null,
        ganador: null, is_wo: false,
        resultado_validado: false,
        anotado_por: null, validado_por: null,
        ranking_applied: false,
      })
      ntf('Resultado cancelado. El partido volvió a estado activo.')
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
    if (!c.slot_court) { ntf('Debes indicar la cancha donde jugaron.', 'err'); return }
    if (!c.slot_day) { ntf('Debes indicar la fecha del partido.', 'err'); return }
    if (!c.slot_hour) { ntf('Debes indicar la hora del partido.', 'err'); return }

    // Si el slot vino del formulario inline (no estaba en BD), guardarlo primero
    const inlineSlot = slotInfo[c.id]
    if (inlineSlot?.court || inlineSlot?.day || inlineSlot?.hour) {
      await updateChallenge(c.id, {
        slot_court: c.slot_court,
        slot_day: c.slot_day,
        slot_hour: c.slot_hour,
      })
    }

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
      const tbStr = isTB ? ` (${tbA}-${tbB})` : ''
      const waText = `🎾 *Escalerilla BOA*\n\n✅ Resultado: ${c.challenger?.nombre} ${sa}-${sb}${tbStr} ${c.challenged?.nombre}\nGana: ${winnerP?.nombre}\n\nVer resultados: https://escalerilla-boa.vercel.app`
      window.open(`https://wa.me/?text=${encodeURIComponent(waText)}`, '_blank')
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

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '0.5px solid #e0dfd8', marginBottom: 14 }}>
        {[['partidos','Partidos'],['ranking','Ranking semanal']].map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            flex: 1, padding: '8px 0', fontSize: 13, cursor: 'pointer', border: 'none',
            background: 'transparent', color: activeTab === tab ? '#1D9E75' : '#888',
            borderBottom: activeTab === tab ? '2px solid #1D9E75' : '2px solid transparent',
            fontWeight: activeTab === tab ? 500 : 400,
          }}>{label}</button>
        ))}
      </div>

      {/* ── RANKING SEMANAL ── */}
      {activeTab === 'ranking' && (
        <div>
          {rankingHistory.length === 0
            ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: 24 }}>Sin historial aún. Se genera cada jueves al publicar el ranking.</p>
            : (() => {
              const week = rankingHistory[selectedWeekIdx]
              const prevWeek = rankingHistory[selectedWeekIdx + 1]
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => setSelectedWeekIdx(i => Math.min(i + 1, rankingHistory.length - 1))}
                      disabled={selectedWeekIdx >= rankingHistory.length - 1}>← Anterior</button>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>Semana {week.semana}</div>
                      <div style={{ fontSize: 11, color: '#888' }}>{week.fecha}</div>
                      {selectedWeekIdx === 0 && <span className="badge badge-green" style={{ fontSize: 10 }}>Última</span>}
                    </div>
                    <button className="btn" style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => setSelectedWeekIdx(i => Math.max(i - 1, 0))}
                      disabled={selectedWeekIdx === 0}>Siguiente →</button>
                  </div>
                  <div className="card">
                    {(week.data || []).map((p) => {
                      const prev = prevWeek?.data?.find(x => x.id === p.id)
                      const diff = prev ? prev.posicion - p.posicion : 0
                      return (
                        <div key={p.id} className="row-item">
                          <span style={{ width: 24, textAlign: 'center', fontSize: 13, fontWeight: 500, color: p.posicion <= 3 ? '#BA7517' : '#888' }}>{p.posicion}</span>
                          <span style={{ flex: 1, fontSize: 13 }}>{p.nombre} {p.apellido}</span>
                          <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{p.victorias}V {p.derrotas}D</span>
                          {diff > 0 && <span style={{ fontSize: 11, color: '#3B6D11' }}>↑{diff}</span>}
                          {diff < 0 && <span style={{ fontSize: 11, color: '#A32D2D' }}>↓{Math.abs(diff)}</span>}
                          {diff === 0 && prev && <span style={{ fontSize: 11, color: '#888' }}>—</span>}
                        </div>
                      )
                    })}
                  </div>
                  {rankingHistory.length > 1 && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {rankingHistory.map((w, i) => (
                        <button key={w.id} className="btn" style={{ fontSize: 11, padding: '2px 8px', background: i === selectedWeekIdx ? '#1D9E75' : 'transparent', color: i === selectedWeekIdx ? '#fff' : '#555', borderColor: i === selectedWeekIdx ? '#1D9E75' : '#ddd' }}
                          onClick={() => setSelectedWeekIdx(i)}>S{w.semana}</button>
                      ))}
                    </div>
                  )}
                </>
              )
            })()
          }
        </div>
      )}

      {/* ── PARTIDOS ── */}
      {activeTab === 'partidos' && toReport.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="section-title">Anotar resultado</div>
          {toReport.map(c => {
            const sa = scores[c.id + '_a'] || ''
            const sb = scores[c.id + '_b'] || ''
            const isTB = (parseInt(sa) === 9 && parseInt(sb) === 8) || (parseInt(sa) === 8 && parseInt(sb) === 9)
            return (
              <div key={c.id} className="card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.challenger?.nombre} {c.challenger?.apellido?.[0]}.</span>
                  <span style={{ color: '#888' }}>vs</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.challenged?.nombre} {c.challenged?.apellido?.[0]}.</span>
                  {c.slot_court && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>{c.slot_court} · {c.slot_hour}</span>}
                </div>

                {/* Cancha/Fecha/Hora — obligatorios si no tiene reserva */}
                {(!c.slot_court || !c.slot_day || !c.slot_hour) && (
                  <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 10px 4px', marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                      <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
                      Completa los datos del partido para poder guardar el resultado
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 6 }}>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Cancha *</label>
                        <select value={slotInfo[c.id]?.court || c.slot_court || ''}
                          onChange={e => {
                            const val = e.target.value
                            setSlotInfo(s => ({ ...s, [c.id]: { ...s[c.id], court: val } }))
                            c.slot_court = val
                          }}>
                          <option value="">—</option>
                          {['c1','c2','c3'].map(id => <option key={id} value={id}>{id}</option>)}
                        </select>
                      </div>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Fecha *</label>
                        <input type="date" value={slotInfo[c.id]?.day || c.slot_day || ''}
                          onChange={e => {
                            const val = e.target.value
                            setSlotInfo(s => ({ ...s, [c.id]: { ...s[c.id], day: val } }))
                            c.slot_day = val
                          }} />
                      </div>
                      <div className="form-row" style={{ marginBottom: 0 }}>
                        <label>Hora *</label>
                        <input type="time" value={slotInfo[c.id]?.hour || c.slot_hour || ''}
                          onChange={e => {
                            const val = e.target.value
                            setSlotInfo(s => ({ ...s, [c.id]: { ...s[c.id], hour: val } }))
                            c.slot_hour = val
                          }} />
                      </div>
                    </div>
                  </div>
                )}
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

      {activeTab === 'partidos' && toReport.length === 0 && (
        <div className="notif" style={{ background: '#f5f4f0', border: '0.5px solid #e0dfd8', marginBottom: 14 }}>
          <i className="ti ti-info-circle" aria-hidden="true" />
          No tienes partidos activos para anotar resultado.
        </div>
      )}

      {activeTab === 'partidos' && <>
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
                      <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{c.challenger?.nombre} {c.challenger?.apellido?.[0]}.</span>
                      <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>
                        {c.score_a}–{c.score_b}{hasTB ? ` (${c.tiebreak_a}–${c.tiebreak_b})` : ''}{c.is_wo ? ' (WO)' : ''}
                      </span>
                      <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{c.challenged?.nombre} {c.challenged?.apellido?.[0]}.</span>
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
                    {canEdit(c) && !isEditing && (
                      <button className="btn btn-reject" style={{ fontSize: 11, padding: '2px 8px', marginLeft: 2 }}
                        onClick={() => cancelResult(c)}>
                        Cancelar
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
      </>}
    </div>
  )
}