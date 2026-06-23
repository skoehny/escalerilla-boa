import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../components/SessionContext'
import { supabase } from '../lib/supabase'

// Pasos: 'phone' → 'complete' (primer ingreso) | 'pin' (ya registrado) | 'done'
export default function Auth() {
  const [step, setStep] = useState('phone')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tel, setTel] = useState('')
  const [player, setPlayer] = useState(null)

  // Completar perfil
  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [showPin, setShowPin] = useState(false)

  // Login con PIN
  const [loginPin, setLoginPin] = useState('')
  const [showLoginPin, setShowLoginPin] = useState(false)
  const [pinResetSent, setPinResetSent] = useState(false)
  const [pinResetCopied, setPinResetCopied] = useState(false)

  const { login } = useSession()
  const navigate = useNavigate()

  // PASO 1 — buscar por teléfono
  async function handlePhone(e) {
    e.preventDefault()
    setError('')
    // Solo dígitos; quitar prefijo país 56 únicamente si viene al inicio (11 dígitos)
    let t = tel.replace(/\D/g, '')
    if (t.length === 11 && t.startsWith('56')) t = t.slice(2)
    if (!/^9\d{8}$/.test(t)) { setError('Ingresa 9 dígitos válidos (ej: 9 1234 5678)'); return }
    setLoading(true)
    try {
      const { data, error: err } = await supabase
        .from('players')
        .select('*')
        .eq('telefono', t)
        .single()
      if (err || !data) { setError('Teléfono no encontrado. Contacta al admin.'); return }
      setPlayer(data)
      // Si ya tiene email y PIN → pedir PIN
      // Si no → completar perfil
      if (data.email && data.pin_hash) {
        setStep('pin')
      } else {
        setStep('complete')
      }
    } finally {
      setLoading(false)
    }
  }

  // PASO 2A — completar perfil (primer ingreso)
  async function handleComplete(e) {
    e.preventDefault()
    setError('')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Email inválido'); return }
    if (!/^\d{4,8}$/.test(pin)) { setError('PIN debe tener 4 a 8 dígitos'); return }
    if (pin !== pin2) { setError('Los PINs no coinciden'); return }
    setLoading(true)
    try {
      // Verificar que email no esté en uso
      const { data: existing } = await supabase
        .from('players')
        .select('id')
        .eq('email', email.trim())
        .neq('id', player.id)
        .single()
      if (existing) { setError('Ese email ya está registrado por otro jugador'); return }

      // Hashear PIN vía función de Supabase
      const { data: hash } = await supabase.rpc('hash_pin', { pin })

      const { data: updated, error: err } = await supabase
        .from('players')
        .update({ email: email.trim(), pin_hash: hash })
        .eq('id', player.id)
        .select()
        .single()
      if (err) throw err
      login(updated)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleForgotPin() {
    try {
      const { error } = await supabase.rpc('solicitar_reset_pin', { p_id: player.id })
      if (error) throw error
      const msg = `Hola administrador, olvidé mi PIN en la Escalerilla BOA y necesito resetearlo. Soy ${player.nombre} ${player.apellido}.`
      if (navigator.share) {
        await navigator.share({ text: msg })
      } else {
        await navigator.clipboard.writeText(msg)
        setPinResetCopied(true)
      }
      setPinResetSent(true)
    } catch (err) {
      if (err?.name !== 'AbortError') setError('No se pudo enviar la solicitud. Intenta de nuevo.')
    }
  }

  // PASO 2B — ingresar con PIN
  async function handlePin(e) {
    e.preventDefault()
    setError('')
    if (!loginPin) { setError('Ingresa tu PIN'); return }
    setLoading(true)
    try {
      const { data: ok } = await supabase.rpc('verify_pin', { pin: loginPin, hash: player.pin_hash })
      if (!ok) { setError('PIN incorrecto'); return }
      login(player)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={S.logoIcon}>
            <i className="ti ti-tennis" style={{ fontSize: 20, color: '#0F6E56' }} aria-hidden="true" />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 500 }}>Escalerilla BOA</h1>
          <p style={{ fontSize: 13, color: '#888', marginTop: 3 }}>Club BOA · Santiago</p>
        </div>

        {error && (
          <div className="notif notif-err" style={{ marginBottom: 12 }}>
            <i className="ti ti-alert-triangle" aria-hidden="true" /> {error}
          </div>
        )}

        {/* PASO 1 — teléfono */}
        {step === 'phone' && (
          <form onSubmit={handlePhone}>
            <div className="form-row">
              <label>Tu teléfono</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={S.prefix}>🇨🇱 +56</span>
                <input
                  type="tel"
                  value={tel}
                  onChange={e => setTel(e.target.value.replace(/[^0-9]/g, '').slice(0, 9))}
                  placeholder="912345678"
                  autoComplete="tel"
                  inputMode="numeric"
                  maxLength={9}
                  style={{ flex: 1 }}
                  autoFocus
                />
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>
                El mismo que usas en WhatsApp
              </div>
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading ? 'Buscando...' : 'Continuar →'}
            </button>
          </form>
        )}

        {/* PASO 2A — completar perfil (primer ingreso) */}
        {step === 'complete' && player && (
          <form onSubmit={handleComplete}>
            <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {player.nombre} {player.apellido}
              </div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                Posición #{player.posicion} · Primer ingreso — completa tus datos
              </div>
            </div>
            <div className="form-row">
              <label>Email *</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="tucorreo@gmail.com"
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="form-row">
              <label>Crear PIN *</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPin ? 'text' : 'password'}
                  value={pin}
                  onChange={e => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                  placeholder="••••"
                  maxLength={8}
                  inputMode="numeric"
                  style={{ paddingRight: 36 }}
                />
                <button type="button" onClick={() => setShowPin(v => !v)} style={S.eyeBtn} aria-label="Mostrar PIN">
                  <i className={`ti ${showPin ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>4 a 8 dígitos</div>
            </div>
            <div className="form-row">
              <label>Confirmar PIN *</label>
              <input
                type="password"
                value={pin2}
                onChange={e => setPin2(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                placeholder="••••"
                maxLength={8}
                inputMode="numeric"
              />
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading ? 'Guardando...' : 'Entrar a la escalerilla →'}
            </button>
            <button type="button" className="btn btn-block" style={{ marginTop: 6, color: '#888' }}
              onClick={() => { setStep('phone'); setError('') }}>
              ← Volver
            </button>
          </form>
        )}

        {/* PASO 2B — ingresar con PIN */}
        {step === 'pin' && player && (
          <form onSubmit={handlePin}>
            <div style={{ background: '#f5f4f0', borderRadius: 8, padding: '10px 12px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="avatar" style={{ width: 36, height: 36, fontSize: 13 }}>
                {(player.nombre?.[0] || '') + (player.apellido?.[0] || '')}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{player.nombre} {player.apellido}</div>
                <div style={{ fontSize: 12, color: '#888' }}>#{player.posicion} en el ranking</div>
              </div>
            </div>
            <div className="form-row">
              <label>PIN</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showLoginPin ? 'text' : 'password'}
                  value={loginPin}
                  onChange={e => setLoginPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                  placeholder="••••"
                  maxLength={8}
                  inputMode="numeric"
                  autoComplete="current-password"
                  style={{ paddingRight: 36 }}
                  autoFocus
                />
                <button type="button" onClick={() => setShowLoginPin(v => !v)} style={S.eyeBtn} aria-label="Mostrar PIN">
                  <i className={`ti ${showLoginPin ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                </button>
              </div>
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
            <button type="button" className="btn btn-block" style={{ marginTop: 6, color: '#888' }}
              onClick={() => { setStep('phone'); setError('') }}>
              ← Volver
            </button>
            {!pinResetSent ? (
              <button type="button"
                style={{ marginTop: 10, width: '100%', background: 'none', border: 'none',
                         color: '#A32D2D', fontSize: 12, cursor: 'pointer', padding: '6px 0' }}
                onClick={handleForgotPin}>
                Olvidé mi PIN
              </button>
            ) : (
              <div className="notif notif-ok" style={{ marginTop: 10, fontSize: 12 }}>
                <i className="ti ti-check" aria-hidden="true" />
                {pinResetCopied
                  ? ' Solicitud registrada. Mensaje copiado — envíaselo al admin por WhatsApp. Cuando lo resetee, podrás crear un PIN nuevo.'
                  : ' Solicitud enviada. El administrador reseteará tu PIN y podrás crear uno nuevo al volver a entrar.'}
              </div>
            )}
          </form>
        )}

      </div>
    </div>
  )
}

const S = {
  wrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', padding: '1.5rem', background: '#f5f4f0',
  },
  card: {
    background: '#fff', border: '0.5px solid #e0dfd8',
    borderRadius: 12, padding: '1.75rem',
    width: '100%', maxWidth: 340,
  },
  logoIcon: {
    width: 44, height: 44, borderRadius: '50%', background: '#E1F5EE',
    display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px',
  },
  eyeBtn: {
    position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
    cursor: 'pointer', color: '#888', background: 'none', border: 'none',
    fontSize: 16, padding: 0, display: 'flex', alignItems: 'center',
  },
  prefix: {
    display: 'flex', alignItems: 'center', padding: '0 10px',
    background: '#f5f4f0', border: '0.5px solid #ccc',
    borderRadius: 8, fontSize: 13, color: '#888',
    whiteSpace: 'nowrap', height: 36, flexShrink: 0,
  },
}
