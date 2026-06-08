import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginPlayer, registerPlayer } from '../lib/supabase'
import { useSession } from '../components/SessionContext'

const WA_GROUP = import.meta.env.VITE_WA_GROUP || 'https://chat.whatsapp.com/XXXXXXXXXXXXXXX'

export default function Auth() {
  const [tab, setTab] = useState('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [registered, setRegistered] = useState(null)
  const { login } = useSession()
  const navigate = useNavigate()

  // Login state
  const [lEmail, setLEmail] = useState('')
  const [lPin, setLPin] = useState('')
  const [lShowPin, setLShowPin] = useState(false)

  // Register state
  const [rNombre, setRNombre] = useState('')
  const [rApellido, setRApellido] = useState('')
  const [rEmail, setREmail] = useState('')
  const [rTel, setRTel] = useState('')
  const [rPin, setRPin] = useState('')
  const [rShowPin, setRShowPin] = useState(false)
  const [rErrors, setRErrors] = useState({})

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    if (!lEmail || !lPin) { setError('Completa email y PIN'); return }
    setLoading(true)
    try {
      const player = await loginPlayer({ email: lEmail.trim(), pin: lPin })
      if (!player.activo) { setError('Tu cuenta está pendiente de activación por el admin.'); return }
      login(player)
      navigate('/')
    } catch (err) {
      setError(err.message || 'Email o PIN incorrecto')
    } finally {
      setLoading(false)
    }
  }

  function validateRegister() {
    const errs = {}
    if (!rNombre.trim()) errs.nombre = 'Requerido'
    if (!rApellido.trim()) errs.apellido = 'Requerido'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rEmail)) errs.email = 'Email inválido'
    if (!/^9\d{8}$/.test(rTel.replace(/\s/g, ''))) errs.tel = 'Ingresa 9 dígitos válidos (empieza en 9)'
    if (!/^\d{4,8}$/.test(rPin)) errs.pin = 'PIN debe tener 4 a 8 dígitos'
    return errs
  }

  async function handleRegister(e) {
    e.preventDefault()
    const errs = validateRegister()
    setRErrors(errs)
    if (Object.keys(errs).length) return
    setLoading(true)
    setError('')
    try {
      await registerPlayer({
        nombre: rNombre.trim(),
        apellido: rApellido.trim(),
        email: rEmail.trim(),
        pin: rPin,
        telefono: rTel.replace(/\s/g, ''),
      })
      setRegistered({ nombre: rNombre, apellido: rApellido, email: rEmail, tel: rTel })
    } catch (err) {
      setError(err.message?.includes('unique') ? 'Ese email ya está registrado' : err.message)
    } finally {
      setLoading(false)
    }
  }

  if (registered) {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ ...styles.logoIcon, background: '#EAF3DE', margin: '0 auto 10px' }}>
              <i className="ti ti-check" style={{ fontSize: 22, color: '#0F6E56' }} aria-hidden="true" />
            </div>
            <h2 style={{ fontSize: 16, fontWeight: 500 }}>Bienvenido, {registered.nombre}</h2>
            <p style={{ fontSize: 13, color: '#888', marginTop: 4 }}>
              Cuenta creada. El admin te activará en el ranking.
            </p>
          </div>
          <div style={styles.profileCard}>
            <div className="avatar" style={{ width: 38, height: 38, fontSize: 13 }}>
              {(registered.nombre[0] + registered.apellido[0]).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 500 }}>{registered.nombre} {registered.apellido}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{registered.email}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                <i className="ti ti-phone" style={{ fontSize: 12, verticalAlign: -1, marginRight: 3 }} aria-hidden="true" />
                +56 {registered.tel}
              </div>
            </div>
          </div>
          <a href={WA_GROUP} target="_blank" rel="noreferrer" style={styles.waBtn}>
            <i className="ti ti-brand-whatsapp" style={{ fontSize: 17 }} aria-hidden="true" />
            Unirse al grupo BOA
          </a>
          <button className="btn btn-block" style={{ marginTop: 8 }} onClick={() => setTab('login')}>
            Ir al ingreso
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={styles.logoIcon}>
            <i className="ti ti-tennis" style={{ fontSize: 20, color: '#0F6E56' }} aria-hidden="true" />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 500 }}>Escalerilla BOA</h1>
          <p style={{ fontSize: 13, color: '#888', marginTop: 3 }}>Club BOA · Santiago</p>
        </div>

        {error && (
          <div className="notif notif-err">
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            {error}
          </div>
        )}

        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(tab === 'login' ? styles.tabActive : {}) }}
            onClick={() => { setTab('login'); setError('') }}
          >Ingresar</button>
          <button
            style={{ ...styles.tab, ...(tab === 'register' ? styles.tabActive : {}) }}
            onClick={() => { setTab('register'); setError('') }}
          >Registrarse</button>
        </div>

        {tab === 'login' && (
          <form onSubmit={handleLogin}>
            <div className="form-row">
              <label>Email</label>
              <input type="email" value={lEmail} onChange={e => setLEmail(e.target.value)}
                placeholder="tucorreo@gmail.com" autoComplete="email" />
            </div>
            <div className="form-row">
              <label>PIN</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={lShowPin ? 'text' : 'password'}
                  value={lPin}
                  onChange={e => setLPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                  placeholder="••••"
                  maxLength={8}
                  inputMode="numeric"
                  autoComplete="current-password"
                  style={{ paddingRight: 36 }}
                />
                <button type="button" onClick={() => setLShowPin(v => !v)}
                  style={styles.eyeBtn} aria-label="Mostrar PIN">
                  <i className={`ti ${lShowPin ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>4 a 8 dígitos</div>
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        )}

        {tab === 'register' && (
          <form onSubmit={handleRegister}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="form-row">
                <label>Nombre *</label>
                <input type="text" value={rNombre} onChange={e => setRNombre(e.target.value)}
                  placeholder="Ignacio" autoComplete="given-name" />
                {rErrors.nombre && <div className="form-err">{rErrors.nombre}</div>}
              </div>
              <div className="form-row">
                <label>Apellido *</label>
                <input type="text" value={rApellido} onChange={e => setRApellido(e.target.value)}
                  placeholder="Torres" autoComplete="family-name" />
                {rErrors.apellido && <div className="form-err">{rErrors.apellido}</div>}
              </div>
            </div>
            <div className="form-row">
              <label>Email *</label>
              <input type="email" value={rEmail} onChange={e => setREmail(e.target.value)}
                placeholder="tucorreo@gmail.com" autoComplete="email" />
              {rErrors.email && <div className="form-err">{rErrors.email}</div>}
            </div>
            <div className="form-row">
              <label>Teléfono *</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={styles.prefix}>🇨🇱 +56</span>
                <input type="tel" value={rTel}
                  onChange={e => setRTel(e.target.value.replace(/[^0-9\s]/g, '').slice(0, 9))}
                  placeholder="9 1234 5678" maxLength={9} style={{ flex: 1 }} />
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>9 dígitos · para el grupo de WhatsApp</div>
              {rErrors.tel && <div className="form-err">{rErrors.tel}</div>}
            </div>
            <div className="form-row">
              <label>PIN *</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={rShowPin ? 'text' : 'password'}
                  value={rPin}
                  onChange={e => setRPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                  placeholder="••••"
                  maxLength={8}
                  inputMode="numeric"
                  autoComplete="new-password"
                  style={{ paddingRight: 36 }}
                />
                <button type="button" onClick={() => setRShowPin(v => !v)}
                  style={styles.eyeBtn} aria-label="Mostrar PIN">
                  <i className={`ti ${rShowPin ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 3 }}>4 a 8 dígitos · úsalo para ingresar</div>
              {rErrors.pin && <div className="form-err">{rErrors.pin}</div>}
            </div>
            <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
              {loading ? 'Creando cuenta...' : 'Crear cuenta'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles = {
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
  tabs: { display: 'flex', borderBottom: '0.5px solid #e0dfd8', marginBottom: '1.25rem' },
  tab: {
    flex: 1, padding: 8, fontSize: 13, cursor: 'pointer',
    border: 'none', background: 'transparent', color: '#888',
    borderBottom: '2px solid transparent', marginBottom: -0.5,
  },
  tabActive: { color: '#1D9E75', borderBottomColor: '#1D9E75', fontWeight: 500 },
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
  profileCard: {
    background: '#f5f4f0', borderRadius: 8, padding: 12,
    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
  },
  waBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, width: '100%', padding: 9, borderRadius: 8,
    border: '0.5px solid #1D9E75', background: '#E1F5EE',
    color: '#085041', fontSize: 13, fontWeight: 500,
    cursor: 'pointer', textDecoration: 'none',
  },
}
