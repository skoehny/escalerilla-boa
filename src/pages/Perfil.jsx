import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../components/SessionContext'
import { supabase, getChallenges } from '../lib/supabase'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }


function courtDot(courtId) {
  const isHard = courtId === 'c3'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: isHard ? '#60B8E0' : '#E8712A',
    marginRight: 4, flexShrink: 0, verticalAlign: 'middle'
  }} title={isHard ? 'Cancha dura' : 'Arcilla'} />
}

export default function Perfil() {
  const { player, updateSession, logout } = useSession()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ nombre: player?.nombre || '', apellido: player?.apellido || '', email: player?.email || '' })
  const [pinForm, setPinForm] = useState({ current: '', new: '', confirm: '' })
  const [showPin, setShowPin] = useState(false)
  const [history, setHistory] = useState([])
  const [notif, setNotif] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadHistory() }, [])

  async function loadHistory() {
    const data = await getChallenges()
    const mine = data.filter(c =>
      (c.challenger_id === player?.id || c.challenged_id === player?.id) && c.status === 'completed'
    ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    setHistory(mine)
  }

  function ntf(msg, type = 'ok') { setNotif({ msg, type }); setTimeout(() => setNotif(null), 3500) }

  async function saveProfile() {
    if (!form.nombre.trim() || !form.apellido.trim()) { ntf('Nombre y apellido son obligatorios', 'err'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) { ntf('Email inválido', 'err'); return }
    setLoading(true)
    try {
      const { data, error } = await supabase.from('players').update({
        nombre: form.nombre.trim(), apellido: form.apellido.trim(),
        email: form.email.trim(),
      }).eq('id', player.id).select().single()
      if (error) throw error
      updateSession(data)
      setEditing(false)
      ntf('Perfil actualizado.')
    } catch (err) { ntf(err.message, 'err') }
    finally { setLoading(false) }
  }

  async function savePin() {
    if (!/^\d{4,8}$/.test(pinForm.new)) { ntf('PIN debe tener 4 a 8 dígitos', 'err'); return }
    if (pinForm.new !== pinForm.confirm) { ntf('Los PINs no coinciden', 'err'); return }
    setLoading(true)
    try {
      const { data: ok } = await supabase.rpc('verify_pin', { pin: pinForm.current, hash: player.pin_hash })
      if (!ok) { ntf('PIN actual incorrecto', 'err'); return }
      const { data: hash } = await supabase.rpc('hash_pin', { pin: pinForm.new })
      const { data, error } = await supabase.from('players').update({ pin_hash: hash }).eq('id', player.id).select().single()
      if (error) throw error
      updateSession(data)
      setPinForm({ current: '', new: '', confirm: '' })
      ntf('PIN actualizado.')
    } catch (err) { ntf(err.message, 'err') }
    finally { setLoading(false) }
  }

  function handleLogout() { logout(); navigate('/auth') }

  const wins = history.filter(c =>
    (c.ganador === 'challenger' && c.challenger_id === player?.id) ||
    (c.ganador === 'challenged' && c.challenged_id === player?.id)
  )

  function fmtDate(d) {
    if (!d) return ''
    try {
      const dt = (typeof d === 'string' && d.length === 10 && d.includes('-')) ? new Date(d + 'T12:00:00') : new Date(d)
      return dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' })
    } catch { return d }
  }

  return (
    <div>
      {notif && <div className={`notif notif-${notif.type}`}><i className={`ti ti-${notif.type === 'ok' ? 'check' : 'alert-triangle'}`} aria-hidden="true" /> {notif.msg}</div>}

      {/* Header */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <div className="avatar" style={{ width: 52, height: 52, fontSize: 18 }}>{ini(player?.nombre, player?.apellido)}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{player?.nombre} {player?.apellido}</div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>#{player?.posicion} en el ranking</div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>{wins.length}V {history.length - wins.length}D · {history.length} partidos</div>
        </div>
        <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={() => setEditing(v => !v)}>
          {editing ? 'Cancelar' : 'Editar'}
        </button>
      </div>

      {/* Lesión */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Estado de lesión</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
              {player?.lesionado
                ? `Lesionado${player.lesion_nota ? ` — ${player.lesion_nota}` : ''} · No puedes recibir desafíos`
                : 'Sin lesión · Disponible para jugar'}
            </div>
          </div>
          {player?.lesionado
            ? <button className="btn btn-accept" style={{ fontSize: 12 }} onClick={async () => {
                const { data, error } = await supabase.from('players').update({ lesionado: false, lesion_nota: '' }).eq('id', player.id).select().single()
                if (!error) { updateSession(data); ntf('Diste de alta. Ya puedes recibir desafíos.') }
              }}>Dar de alta</button>
            : <button className="btn btn-reject" style={{ fontSize: 12 }} onClick={async () => {
                const nota = window.prompt('Descripción de la lesión (opcional):') || ''
                const { data, error } = await supabase.from('players').update({ lesionado: true, lesion_nota: nota }).eq('id', player.id).select().single()
                if (!error) { updateSession(data); ntf('Marcado como lesionado. No recibirás desafíos.', 'warn') }
              }}>Marcar lesión</button>
          }
        </div>
      </div>

      {/* Editar perfil */}
      {editing && (
        <div className="card" style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Editar perfil</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="form-row"><label>Nombre</label><input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} /></div>
            <div className="form-row"><label>Apellido</label><input value={form.apellido} onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))} /></div>
          </div>
          <div className="form-row"><label>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
          <div className="form-row">
            <label>Teléfono</label>
            <input value={`🇨🇱 +56 ${player?.telefono || ''}`} disabled style={{ background: '#f5f4f0', color: '#888', cursor: 'not-allowed' }} />
            <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>Solo el administrador puede modificar tu teléfono</div>
          </div>
          {/* Posición — solo lectura para jugadores */}
          <div className="form-row">
            <label>Posición en el ranking</label>
            <input value={player?.posicion || ''} disabled style={{ background: '#f5f4f0', color: '#888', cursor: 'not-allowed' }} />
            <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>Solo el administrador puede modificar la posición</div>
          </div>
          <button className="btn btn-primary btn-block" onClick={saveProfile} disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      )}

      {/* Cambiar PIN */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Cambiar PIN</div>
        <div className="form-row">
          <label>PIN actual</label>
          <input type={showPin ? 'text' : 'password'} value={pinForm.current}
            onChange={e => setPinForm(f => ({ ...f, current: e.target.value.replace(/[^0-9]/g, '').slice(0, 8) }))}
            placeholder="••••" maxLength={8} inputMode="numeric" />
        </div>
        <div className="form-row">
          <label>PIN nuevo</label>
          <input type={showPin ? 'text' : 'password'} value={pinForm.new}
            onChange={e => setPinForm(f => ({ ...f, new: e.target.value.replace(/[^0-9]/g, '').slice(0, 8) }))}
            placeholder="••••" maxLength={8} inputMode="numeric" />
        </div>
        <div className="form-row">
          <label>Confirmar PIN nuevo</label>
          <input type={showPin ? 'text' : 'password'} value={pinForm.confirm}
            onChange={e => setPinForm(f => ({ ...f, confirm: e.target.value.replace(/[^0-9]/g, '').slice(0, 8) }))}
            placeholder="••••" maxLength={8} inputMode="numeric" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <input type="checkbox" id="show-pin" checked={showPin} onChange={e => setShowPin(e.target.checked)} style={{ width: 16, height: 16 }} />
          <label htmlFor="show-pin" style={{ fontSize: 12, color: '#888' }}>Mostrar PINs</label>
        </div>
        <button className="btn btn-accept btn-block" onClick={savePin} disabled={loading}>
          {loading ? 'Guardando...' : 'Cambiar PIN'}
        </button>
      </div>

      {/* Historial */}
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
      <div className="card" style={{ marginBottom: 10 }}>
        {history.length === 0
          ? <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: '12px 0' }}>Sin partidos jugados aún</p>
          : history.map(c => {
            const isChallenger = c.challenger_id === player?.id
            const won = (c.ganador === 'challenger' && isChallenger) || (c.ganador === 'challenged' && !isChallenger)
            const rival = isChallenger ? c.challenged : c.challenger
            const myScore = isChallenger ? c.score_a : c.score_b
            const rivalScore = isChallenger ? c.score_b : c.score_a
            const hasTB = c.tiebreak_a !== null && c.tiebreak_b !== null
            return (
              <div key={c.id} className="row-item">
                <span className={`badge ${won ? 'badge-green' : 'badge-red'}`} style={{ flexShrink: 0, width: 20, textAlign: 'center' }}>{won ? 'W' : 'L'}</span>
                <span style={{ flex: 1, fontSize: 13 }}>vs {rival?.nombre} {rival?.apellido}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {myScore}–{rivalScore}{hasTB ? ` (${isChallenger ? c.tiebreak_a : c.tiebreak_b}–${isChallenger ? c.tiebreak_b : c.tiebreak_a})` : ''}{c.is_wo ? ' (WO)' : ''}
                </span>
                <span style={{ fontSize: 11, color: '#888', marginLeft: 6 }}>{fmtDate(c.created_at)}</span>
              </div>
            )
          })
        }
      </div>

      {/* Cerrar sesión */}
      <button className="btn btn-block" style={{ color: '#A32D2D', borderColor: '#F09595', marginBottom: 20 }} onClick={handleLogout}>
        <i className="ti ti-logout" style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" />
        Cerrar sesión
      </button>
    </div>
  )
}