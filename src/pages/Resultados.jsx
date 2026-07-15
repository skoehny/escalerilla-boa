import { useState, useEffect } from 'react'
import { getChallenges, updateChallenge, getPlayers, supabase } from '../lib/supabase'
import { notifyResult } from '../lib/notify'
import { useSession } from '../components/SessionContext'
import SetsInput, { emptySets, setsFromChallenge } from '../components/SetsInput'
import { validarMarcador, setsPayload, marcadorTexto, FORMATOS } from '../lib/formato'

function fmtDate(d) {
  if (!d) return ''
  try {
    const dt = (typeof d === 'string' && d.length === 10 && d.includes('-')) ? new Date(d + 'T12:00:00') : new Date(d)
    return dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  } catch { return d }
}

// Mensaje limpio de una RPC de Postgres (quita el prefijo "<fn> falló: ")
function rpcMsg(error) {
  let m = error?.message || 'Error desconocido'
  m = m.replace(/^[a-z_]+ falló:\s*/i, '')
  return m
}

function courtDot(courtId) {
  const isHard = courtId === 'c3'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: isHard ? '#60B8E0' : '#E8712A',
    marginRight: 4, flexShrink: 0, verticalAlign: 'middle'
  }} title={isHard ? 'Cancha dura' : 'Arcilla'} />
}

// mm:ss a partir de milisegundos
function fmtRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}`
}

export default function Resultados() {
  const { player, updateSession } = useSession()
  const [challenges, setChallenges] = useState([])
  const [players, setPlayers] = useState([])
  const [setsMap, setSetsMap] = useState({})   // por challenge: array de {a,b} (strings)
  const [editSets, setEditSets] = useState([]) // corrección en curso
  const [slotInfo, setSlotInfo] = useState({}) // cancha/fecha/hora inline al anotar resultado
  const [editingId, setEditingId] = useState(null) // id del desafío en modo "Corregir"
  const [loading, setLoading] = useState(true)
  const [notif, setNotif] = useState(null)
  const [activeTab, setActiveTab] = useState('partidos')
  const [rankingHistory, setRankingHistory] = useState([])
  const [selectedWeekIdx, setSelectedWeekIdx] = useState(0)
  const [movDetail, setMovDetail] = useState(null)
  const [v2cfg, setV2cfg] = useState(null)          // v2_config (ventana de validación)
  const [nowTs, setNowTs] = useState(() => Date.now())

  useEffect(() => { load() }, [])

  // Tick de 1s para el contador de la ventana de validación/corrección
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  async function load() {
    try {
      const [ch, pl] = await Promise.all([getChallenges(), getPlayers()])
      setChallenges(ch); setPlayers(pl)
      const [{ data: hist }, { data: cfg2 }] = await Promise.all([
        supabase.from('ranking_history').select('*').order('semana', { ascending: false }).limit(20),
        supabase.from('v2_config').select('*').eq('id', 1).single(),
      ])
      setRankingHistory(hist || [])
      setV2cfg(cfg2 || null)
    } finally { setLoading(false) }
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 4000) }

  // Arma el texto compartible desde el jsonb de una foto de ranking_history
  function shareResumen(week) {
    const lines = [`Escalerilla 🎾 — Ranking Semana ${week.semana}`, '', '🏆 Top 5']
    ;(week.data || []).slice(0, 5).forEach(p => lines.push(`${p.posicion}. ${p.nombre} ${p.apellido}`))
    const movs = week.movimientos?.movements || []
    if (movs.length) {
      lines.push('', '📊 Movimientos de la semana')
      movs.forEach(m => lines.push(`${m.delta > 0 ? '⬆️' : '⬇️'}${Math.abs(m.delta)} ${m.nombre} (#${m.desde}→#${m.hasta})`))
    }
    const notas = week.movimientos?.notas || []
    if (notas.length) {
      lines.push('', '📝 Resumen')
      notas.forEach(n => lines.push(`• ${n}`))
    }
    lines.push('', 'https://escalerilla-boa.vercel.app/')
    const text = lines.join('\n')
    if (navigator.share) { navigator.share({ text }).catch(() => {}) }
    else { navigator.clipboard.writeText(text); ntf('Resumen copiado al portapapeles.') }
  }

  // ── Reglas de estado (v2: aplicación instantánea) ──────────────
  function isMyMatch(c) {
    return c.challenger_id === player?.id || c.challenged_id === player?.id
  }

  // Partido listo para anotar: aceptado y soy parte del partido
  function canReport(c) {
    if (c.status !== 'accepted') return false
    return isMyMatch(c)
  }

  // El único movimiento aplicado más reciente de toda la liga (regla 2)
  const lastAppliedId = challenges
    .filter(c => c.ranking_applied && c.applied_at)
    .sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at))[0]?.id || null

  // Milisegundos restantes de la ventana de validación; null si no aplica contador
  function windowRemaining(c) {
    const mins = v2cfg?.ventana_validacion_minutos
    if (!c.resultado_ingresado_at || mins == null) return null
    const end = new Date(c.resultado_ingresado_at).getTime() + mins * 60000
    return end - nowTs
  }
  function withinWindow(c) {
    const r = windowRemaining(c)
    return r === null ? true : r > 0
  }

  // ¿Este resultado sigue accionable por los 2 jugadores? (aplicado, no validado, último, en ventana)
  function isActionable(c) {
    return c.status === 'completed'
      && c.ranking_applied === true
      && !c.resultado_validado
      && c.id === lastAppliedId
      && isMyMatch(c)
  }
  function canValidate(c) {
    // Anti-auto-validación: el que anotó no valida (solo corrige); valida el rival.
    return isActionable(c) && withinWindow(c) && c.anotado_por !== player?.id
  }
  function canCorregir(c) {
    return isActionable(c) && withinWindow(c)
  }

  async function validateResult(c) {
    try {
      const { error } = await supabase.rpc('validar_resultado', { p_challenge_id: c.id, p_player_id: player.id })
      if (error) throw error
      ntf('Resultado validado. Queda bloqueado.')
      load()
    } catch (err) { ntf(rpcMsg(err), 'err') }
  }

  // Corregir: revierte (snapshot_pre) y reaplica con el nuevo marcador
  async function saveCorreccion(c) {
    const formato = v2cfg?.formato_partido || 'set9'
    const v = await validarMarcador(formato, editSets)
    if (!v.ok) { ntf(v.error || 'Marcador inválido.', 'err'); return }
    try {
      const { error } = await supabase.rpc('corregir_resultado', {
        p_challenge_id: c.id,
        p_editor_id: player.id,
        p_score_a: v.score_a,
        p_score_b: v.score_b,
        p_sets: setsPayload(formato, editSets),
      })
      if (error) throw error
      setEditingId(null)
      // Refrescar sesión (mi posición pudo cambiar)
      const { data: fresh } = await supabase.from('players').select('*').eq('id', player.id).single()
      if (fresh) updateSession(fresh)
      ntf('Resultado corregido y ranking reajustado.')
      load()
    } catch (err) { ntf(rpcMsg(err), 'err') }
  }

  async function saveResult(c) {
    const formato = v2cfg?.formato_partido || 'set9'
    const sets = setsMap[c.id] || emptySets()
    const v = await validarMarcador(formato, sets)
    if (!v.ok) { ntf(v.error || 'Marcador inválido.', 'err'); return }
    // Fecha del partido: ingresada por el usuario, o hoy en hora local (no UTC)
    const finalSlotDay = slotInfo[c.id]?.day || c.slot_day || new Date().toLocaleDateString('en-CA')

    // Cancha/hora: guardar solo si el usuario las ingresó (slot_day va en el update principal)
    const inlineSlot = slotInfo[c.id]
    if (inlineSlot?.court || inlineSlot?.hour) {
      await updateChallenge(c.id, {
        slot_court: c.slot_court,
        slot_hour:  c.slot_hour,
      })
    }

    const winner = v.ganador === 'a' ? 'challenger' : 'challenged'
    const winnerP = winner === 'challenger' ? c.challenger : c.challenged

    try {
      // 1) Guardar el resultado
      await updateChallenge(c.id, {
        status: 'completed', score_a: v.score_a, score_b: v.score_b, ganador: winner,
        sets: setsPayload(formato, sets), slot_day: finalSlotDay,
        anotado_por: player.id, validado_por: null, resultado_validado: false,
        tiebreak_a: null, tiebreak_b: null,
      })
      // 2) Aplicar al ranking AL INSTANTE (mueve posiciones + recalcula stats)
      const { error: applyErr } = await supabase.rpc('aplicar_resultado', { p_challenge_id: c.id })
      if (applyErr) throw applyErr

      await notifyResult(c.challenger, c.challenged, v.score_a, v.score_b, winnerP, null)
      // Refrescar sesión del jugador actual (posición/stats)
      const { data: freshPlayer } = await supabase.from('players').select('*').eq('id', player.id).single()
      if (freshPlayer) updateSession(freshPlayer)
      ntf('Resultado guardado. Ranking actualizado. Tienes un rato para validar o corregir.')
      load()
    } catch (err) { ntf(rpcMsg(err), 'err') }
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
            ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: 24 }}>Sin historial aún. Se genera automáticamente cada jueves (foto del ranking).</p>
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
                      {week.movimientos && (week.movimientos.movements?.length > 0 || week.movimientos.notas?.length > 0) && (
                        <button className="btn" style={{ fontSize: 11, padding: '2px 8px', marginTop: 4 }}
                          onClick={() => setMovDetail(week)}>
                          <i className="ti ti-info-circle" style={{ verticalAlign: -2, marginRight: 3 }} aria-hidden="true" />
                          ¿Por qué estos cambios?
                        </button>
                      )}
                      <button className="btn btn-accept" style={{ fontSize: 11, padding: '2px 10px', marginTop: 4, marginLeft: 4 }}
                        onClick={() => shareResumen(week)}>
                        <i className="ti ti-brand-whatsapp" style={{ verticalAlign: -2, marginRight: 3 }} aria-hidden="true" />
                        Compartir
                      </button>
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
            const formato = v2cfg?.formato_partido || 'set9'
            const sets = setsMap[c.id] || emptySets()
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
                        {(() => { const court = slotInfo[c.id]?.court || c.slot_court; if (!court) return null; const isHard = court === 'c3'; return (<span style={{ fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isHard ? '#60B8E0' : '#E8712A' }} />{isHard ? 'Cancha dura' : 'Arcilla'}</span>) })()}
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
                <SetsInput formato={formato} sets={sets}
                  setSets={(next) => setSetsMap(m => ({ ...m, [c.id]: next }))}
                  nameA={c.challenger?.nombre} nameB={c.challenged?.nombre} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: '#888' }}>{FORMATOS[formato]?.label}</span>
                  <button className="btn btn-accept" onClick={() => saveResult(c)}>Guardar</button>
                </div>
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
        {completed.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin partidos jugados aún</p>
          : (() => {
            // "Por validar": aplicados y aún sin validar (arriba); resto = historial
            const porValidar = completed.filter(c => c.ranking_applied === true && !c.resultado_validado)
            const historic = completed.filter(c => !(c.ranking_applied === true && !c.resultado_validado))
            const renderRow = (c) => {
              const w = c.ganador === 'challenger' ? c.challenger : c.challenged
              const isEditing = editingId === c.id
              const actionable = isActionable(c)
              const remaining = windowRemaining(c)
              return (
                <div key={c.id}>
                  <div className="row-item">
                    <span style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ fontWeight: c.ganador === 'challenger' ? 500 : 400 }}>{c.challenger?.nombre} {c.challenger?.apellido?.[0]}.</span>
                      <span style={{ color: '#888', fontSize: 12, margin: '0 5px' }}>
                        {marcadorTexto(c)}{c.is_wo ? ' (WO)' : ''}
                      </span>
                      <span style={{ fontWeight: c.ganador === 'challenged' ? 500 : 400 }}>{c.challenged?.nombre} {c.challenged?.apellido?.[0]}.</span>
                    </span>
                    {c.resultado_validado && <span className="badge badge-green" style={{ fontSize: 10, flexShrink: 0 }} title="Validado">✓</span>}
                    <span className="badge badge-green" style={{ flexShrink: 0 }}>{w?.nombre}</span>
                    {c.slot_court && <span style={{ marginLeft: 4 }}>{courtDot(c.slot_court)}</span>}
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 4, flexShrink: 0 }}>{fmtDate(c.slot_day) || fmtDate(c.created_at)}</span>
                  </div>

                  {/* Panel accionable: resultado aplicado, no validado, último y soy jugador */}
                  {actionable && !isEditing && (
                    <div style={{ background: '#E1F5EE', borderRadius: 8, padding: '10px 12px', margin: '2px 0 8px' }}>
                      {withinWindow(c) ? (
                        <>
                          <div style={{ fontSize: 12, color: '#0F6E56', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <i className="ti ti-clock" aria-hidden="true" />
                            {remaining != null
                              ? <>Ventana para validar o corregir: <strong>{fmtRemaining(remaining)}</strong></>
                              : <>Puedes validar o corregir este resultado</>}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {canValidate(c) && (
                              <button className="btn btn-accept" style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => validateResult(c)}>Validar ✓</button>
                            )}
                            <button className="btn" style={{ fontSize: 12, padding: '4px 12px' }}
                              onClick={() => { setEditingId(c.id); setEditSets(setsFromChallenge(c)) }}>
                              Corregir
                            </button>
                          </div>
                          {!canValidate(c) && (
                            <div style={{ fontSize: 11, color: '#8a6d1a', marginTop: 6 }}>
                              Anotaste este resultado: solo tu rival puede validarlo. Puedes corregirlo si hay un error.
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: '#8a6d1a', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <i className="ti ti-lock" aria-hidden="true" />
                          Ventana de corrección vencida. Si hay un error, contacta a un administrador.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Form de corrección */}
                  {isEditing && (
                    <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Corregir resultado ({FORMATOS[v2cfg?.formato_partido || 'set9']?.label}) — revierte y reaplica el ranking</div>
                      <SetsInput formato={v2cfg?.formato_partido || 'set9'} sets={editSets} setSets={setEditSets}
                        nameA={c.challenger?.nombre} nameB={c.challenged?.nombre} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                        <button className="btn" style={{ fontSize: 12 }} onClick={() => setEditingId(null)}>Cancelar</button>
                        <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => saveCorreccion(c)}>Guardar corrección</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            return (
              <>
                {porValidar.map(renderRow)}
                {porValidar.length > 0 && historic.length > 0 && (
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

      {movDetail && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setMovDetail(null) }}>
          <div className="modal" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <h3>Movimientos — Semana {movDetail.semana}</h3>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>{movDetail.fecha}</p>

            {movDetail.movimientos?.movements?.length > 0 ? (
              <div style={{ marginBottom: 10 }}>
                {movDetail.movimientos.movements.map((m, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '0.5px solid #eee', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: m.delta > 0 ? '#3B6D11' : '#A32D2D', flexShrink: 0, width: 30 }}>
                      {m.delta > 0 ? `↑${m.delta}` : `↓${Math.abs(m.delta)}`}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{m.nombre} <span style={{ color: '#888', fontWeight: 400 }}>#{m.desde} → #{m.hasta}</span></div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>{m.motivo}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: '#888', marginBottom: 10 }}>Sin cambios de posición esta semana.</p>
            )}

            {movDetail.movimientos?.notas?.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Notas</div>
                {movDetail.movimientos.notas.map((n, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#666', padding: '4px 0', display: 'flex', gap: 6 }}>
                    <i className="ti ti-info-circle" style={{ fontSize: 14, flexShrink: 0, marginTop: 1, color: '#888' }} aria-hidden="true" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-accept" onClick={() => setMovDetail(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
