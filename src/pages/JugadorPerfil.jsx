import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, getChallenges } from '../lib/supabase'
import { useSession } from '../components/SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

// Iconos como SVG inline (no dependen de la webfont de Tabler, que renderiza
// vacío cuando el <i> es el único hijo flex de un <button>). Paths = tabler.
function InfoIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}
function CloseIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// Fuente ÚNICA de la inactividad: el contador incremental players.dias_inactivo
// (NO se calcula desde fechas: así respeta el congelamiento global y las pausas).
// S y D se DERIVAN del mismo contador (S = semanas completas, D = resto): así
// "1S 6D" son 13 días, no "1 semana + 13 días". El "D" indica cuán cerca está
// del próximo castigo: con D=6, al día siguiente cruza un umbral múltiplo de 7.
function inactivityTime(player) {
  const dias = player?.dias_inactivo || 0
  if (dias < 7) return null   // mismo umbral que antes (se ocultaba con semanas_inactivo=0)
  return `${Math.floor(dias / 7)}S ${dias % 7}D`
}

function statusText(c) {
  if (!c) return ''
  if (c.status === 'pending') return 'Desafío pendiente de aceptación'
  if (c.status === 'accepted' && !c.slot_day) return 'Acordando día'
  if (c.status === 'accepted' && c.slot_day && !c.pago_confirmado) return `Cancha reservada · ${fmtDate(c.slot_day)} ${c.slot_hour || ''}`
  if (c.status === 'accepted' && c.pago_confirmado) return `Listo para jugar · ${fmtDate(c.slot_day)} ${c.slot_hour || ''}`
  if (c.status === 'completed') return `Jugado: ${c.score_a}–${c.score_b}`
  return ''
}

function fmtDate(d) {
  if (!d) return ''
  try {
    const dt = (typeof d === 'string' && d.length === 10 && d.includes('-')) ? new Date(d + 'T12:00:00') : new Date(d)
    return dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  } catch { return d }
}

function fmtDM(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Días calendario completos entre una fecha y hoy (mínimo 0).
function diasHasta(ts) {
  if (!ts) return null
  const d = new Date(ts), hoy = new Date()
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const b = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  return Math.max(0, Math.round((b - a) / 86400000))
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
  const [freeze, setFreeze] = useState(null)
  const [pausedByChallenge, setPausedByChallenge] = useState(false)
  const [showRelojInfo, setShowRelojInfo] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [id])

  async function load() {
    try {
      const [{ data: j }, ch, { data: fz }] = await Promise.all([
        supabase.from('players').select('*').eq('id', id).single(),
        getChallenges(),
        supabase.from('reloj_freeze_log').select('*').is('descongelado_en', null).maybeSingle()
      ])
      setJugador(j)
      setFreeze(fz || null)
      // El reloj se pausa por tener un desafío pending/accepted (mismo criterio del cron).
      setPausedByChallenge(ch.some(c =>
        (c.challenger_id === id || c.challenged_id === id) &&
        (c.status === 'pending' || c.status === 'accepted')
      ))
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

  // ── Reloj de inactividad (fuente única: contador dias_inactivo) ──────
  const debutante = (jugador.victorias || 0) === 0 && (jugador.derrotas || 0) === 0
  const diasInact = jugador.dias_inactivo || 0
  const diasDesdeUltimo = diasHasta(jugador.ultima_fecha_jugada)      // null si nunca jugó
  const sinReloj = debutante || !jugador.ultima_fecha_jugada
  // Días en que el reloj NO avanzó (pausas por desafío + congelamientos globales).
  const diasPausados = diasDesdeUltimo != null ? Math.max(0, diasDesdeUltimo - diasInact) : 0
  let relojEstado, relojColor
  if (debutante) { relojEstado = 'sin reloj (aún no debuta)'; relojColor = '#888' }
  else if (freeze) { relojEstado = `congelado (${freeze.motivo})`; relojColor = '#A32D2D' }
  else if (jugador.inactividad_congelada) { relojEstado = 'congelado (reloj individual)'; relojColor = '#185FA5' }
  else if (pausedByChallenge) { relojEstado = 'pausado por desafío activo'; relojColor = '#0F6E56' }
  else { relojEstado = 'corriendo'; relojColor = '#888' }
  let proximoUmbral
  if (diasInact < 14) proximoUmbral = 'a los 14 días: baja 2 puestos'
  else if (diasInact < 21) proximoUmbral = 'a los 21 días: baja 1 puesto'
  else if (diasInact < 28) proximoUmbral = 'a los 28 días: baja 1 puesto + insignia de lesionado'
  else proximoUmbral = 'baja 1 puesto cada 7 días adicionales'
  const haceTxt = diasDesdeUltimo === 0 ? 'hoy' : diasDesdeUltimo === 1 ? 'hace 1 día' : `hace ${diasDesdeUltimo} días`

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
            const inactTime = inactivityTime(jugador)
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

      {/* Reloj de inactividad — fuente única: contador dias_inactivo */}
      <div className="card" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, color: '#555', display: 'inline-flex', alignItems: 'center' }}>
          Días de inactividad: <strong style={{ margin: '0 4px' }}>{debutante ? '—' : diasInact}</strong>
          <button onClick={() => setShowRelojInfo(true)} aria-label="¿Cómo funciona el reloj de inactividad?"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#888', padding: 6, lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}>
            <InfoIcon />
          </button>
        </span>
        <span style={{ fontSize: 12, color: relojColor, fontWeight: 500, textAlign: 'right' }}>{relojEstado}</span>
      </div>

      {/* Popup explicativo del reloj de inactividad */}
      {showRelojInfo && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowRelojInfo(false) }}>
          <div className="modal">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>Reloj de inactividad</h3>
              <button onClick={() => setShowRelojInfo(false)} aria-label="Cerrar"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#888', lineHeight: 0, padding: 4, display: 'inline-flex', alignItems: 'center' }}>
                <CloseIcon />
              </button>
            </div>

            <div style={{ fontSize: 13, color: '#444', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>Días de inactividad: <strong>{sinReloj ? '—' : diasInact}</strong></div>

              {sinReloj ? (
                <div style={{ color: '#666' }}>
                  Aún no juega su primer partido — el reloj parte con su primer resultado.
                </div>
              ) : (
                <>
                  <div>Último partido: <strong>{fmtDM(jugador.ultima_fecha_jugada)}</strong> ({haceTxt})</div>
                  <div>
                    Días pausados o congelados: <strong>{diasPausados}</strong>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>(desafíos activos y congelamientos globales pausan el reloj)</div>
                  </div>
                  <div>Estado actual: <span style={{ color: relojColor, fontWeight: 500 }}>{relojEstado}</span></div>
                  <div>Próximo umbral: <strong>{proximoUmbral}</strong></div>
                </>
              )}
            </div>

            <div style={{ fontSize: 11, color: '#888', marginTop: 12, borderTop: '1px solid #ecece4', paddingTop: 10 }}>
              El reloj suma 1 día por cada día sin jugar. Se reinicia a 0 al jugar. Se pausa con desafío pendiente/aceptado o cuando el admin congela el reloj.
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={() => setShowRelojInfo(false)}>Entendido</button>
            </div>
          </div>
        </div>
      )}

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