import { useState, useEffect, useRef } from 'react'
import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom'
import { useSession } from './SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

const THRESHOLD = 120
const RESISTANCE = 0.45

async function hardRefresh() {
  try {
    const keys = await caches.keys()
    await Promise.all(keys.map(k => caches.delete(k)))
  } finally {
    window.location.reload()
  }
}

export default function Layout() {
  const { player, logout } = useSession()
  const navigate = useNavigate()
  const [ptr, setPtr] = useState({ y: 0, releasing: false, triggered: false })
  const headerRef = useRef(null)
  const s = useRef({ startY: null, startX: null, active: false, pulling: false, rawY: 0 })

  function handleLogout() { logout(); navigate('/auth') }

  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY > 0) return
      if (document.querySelector('.modal-overlay')) return
      s.current.startY = e.touches[0].clientY
      s.current.startX = e.touches[0].clientX
      s.current.active = true
      s.current.pulling = false
      s.current.rawY = 0
    }

    function onTouchMove(e) {
      if (!s.current.active) return
      const dy = e.touches[0].clientY - s.current.startY
      const dx = e.touches[0].clientX - s.current.startX

      if (!s.current.pulling) {
        if (dy < 0 || Math.abs(dx) > dy) { s.current.active = false; return }
        if (dy < 10) return
        s.current.pulling = true
      }

      e.preventDefault()
      s.current.rawY = dy
      setPtr({ y: dy * RESISTANCE, releasing: false, triggered: false })
    }

    function onTouchEnd() {
      if (!s.current.active) return
      s.current.active = false
      if (s.current.pulling && s.current.rawY >= THRESHOLD) {
        setPtr({ y: THRESHOLD * RESISTANCE, releasing: false, triggered: true })
        hardRefresh()
      } else {
        setPtr({ y: 0, releasing: true, triggered: false })
        setTimeout(() => setPtr(p => ({ ...p, releasing: false })), 300)
      }
      s.current.pulling = false
      s.current.startY = null
      s.current.startX = null
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd)
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const navItems = player?.es_admin_canchas
    ? [
        { to: '/canchas',    label: 'Canchas',    icon: 'ti-tennis' },
        { to: '/desafios',   label: 'Desafíos',   icon: 'ti-sword'  },
      ]
    : [
        { to: '/',           label: 'Ranking',    icon: 'ti-trophy'    },
        { to: '/desafios',   label: 'Desafíos',   icon: 'ti-sword'     },
        { to: '/resultados', label: 'Resultados', icon: 'ti-chart-bar' },
        { to: '/reglamento', label: 'Bases',      icon: 'ti-book'      },
      ]
  if (player?.es_admin) {
    navItems.splice(2, 0, { to: '/canchas', label: 'Canchas', icon: 'ti-tennis' })
    navItems.push({ to: '/admin', label: 'Admin', icon: 'ti-settings' })
  }

  const visualY = Math.min(ptr.y, THRESHOLD * RESISTANCE)
  const progress = Math.min(ptr.y / (THRESHOLD * RESISTANCE), 1)
  const ready = ptr.triggered || ptr.y >= THRESHOLD * RESISTANCE
  const headerHeight = headerRef.current?.offsetHeight ?? 91

  return (
    <div style={{ minHeight: '100vh', background: '#f5f4f0' }}>

      {/* Header — position sticky + safe-area intactos, nunca se mueve */}
      <div ref={headerRef} style={{ background: '#fff', borderBottom: '0.5px solid #e0dfd8', position: 'sticky', top: 0, zIndex: 50, paddingTop: 'env(safe-area-inset-top)' }}>

        {/* Fila 1: Logo + Perfil */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', height: 46 }}>
          <Link to="/" style={{ textDecoration: 'none', color: 'inherit', fontWeight: 500, fontSize: 16, display: 'flex', alignItems: 'center', gap: 7 }}>
            <i className="ti ti-tennis" style={{ fontSize: 18, color: '#1D9E75' }} aria-hidden="true" />
            Escalerilla BOA
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {player?.lesionado && <span className="badge badge-red" style={{ fontSize: 10 }}>Lesionado</span>}
            <Link to="/perfil" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{ini(player?.nombre, player?.apellido)}</div>
              <span style={{ fontSize: 13, color: '#555' }}>{player?.nombre}</span>
            </Link>
            <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={handleLogout} aria-label="Cerrar sesión">
              <i className="ti ti-logout" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Fila 2: Menú de páginas */}
        <div style={{ display: 'flex', borderTop: '0.5px solid #f0efe8', overflowX: 'auto' }}>
          {navItems.map(item => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}
              style={({ isActive }) => ({
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                padding: '7px 4px', textDecoration: 'none',
                fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0,
                color: isActive ? '#1D9E75' : '#888',
                borderBottom: isActive ? '2px solid #1D9E75' : '2px solid transparent',
                fontWeight: isActive ? 500 : 400,
                gap: 3,
              })}>
              <i className={`ti ${item.icon}`} style={{ fontSize: 18 }} aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Spinner — zIndex 49: el header (50) lo tapa; se revela cuando main baja */}
      {(ptr.y > 0 || ptr.triggered) && (
        <>
          <style>{`@keyframes ptr-spin { to { transform: rotate(360deg) } }`}</style>
          <div style={{
            position: 'fixed',
            top: headerHeight,
            left: 0, right: 0,
            zIndex: 49,
            display: 'flex', justifyContent: 'center',
            paddingTop: 6,
            pointerEvents: 'none',
            opacity: progress,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {ptr.triggered
                ? <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2.5px solid #E1F5EE', borderTopColor: '#1D9E75', animation: 'ptr-spin 0.7s linear infinite' }} />
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={ready ? '#1D9E75' : '#888'} strokeWidth="2.5"
                    style={{ transform: `rotate(${progress * 270}deg)` }}>
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
                  </svg>
              }
            </div>
          </div>
        </>
      )}

      {/* Main — único elemento que se traslada con el gesto */}
      <main style={{
        padding: 14, maxWidth: 700, margin: '0 auto',
        transform: `translateY(${visualY}px)`,
        transition: ptr.releasing ? 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)' : 'none',
        willChange: ptr.y > 0 ? 'transform' : 'auto',
      }}>
        <Outlet />
      </main>
    </div>
  )
}
