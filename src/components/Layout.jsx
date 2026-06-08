import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useSession } from './SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Layout() {
  const { player, logout } = useSession()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/auth')
  }

  const navItems = [
    { to: '/',           label: 'Ranking',    icon: 'ti-trophy'    },
    { to: '/desafios',   label: 'Desafíos',   icon: 'ti-sword'     },
    { to: '/canchas',    label: 'Canchas',    icon: 'ti-tennis'    },
    { to: '/resultados', label: 'Resultados', icon: 'ti-chart-bar' },
  ]
  if (player?.es_admin) {
    navItems.push({ to: '/admin', label: 'Admin', icon: 'ti-settings' })
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f4f0', paddingBottom: 70 }}>

      {/* Top bar — solo logo + avatar en móvil */}
      <nav style={{
        display: 'flex', alignItems: 'center',
        background: '#fff', borderBottom: '0.5px solid #e0dfd8',
        padding: '0 14px', height: 50,
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <span style={{ fontWeight: 500, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-tennis" style={{ fontSize: 15, color: '#1D9E75' }} aria-hidden="true" />
          Escalerilla BOA
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {player?.lesionado && (
            <span className="badge badge-red" style={{ fontSize: 10 }}>Lesionado</span>
          )}
          <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
            {ini(player?.nombre, player?.apellido)}
          </div>
          <span style={{ fontSize: 12, color: '#888' }}>
            {player?.nombre}
          </span>
          <button
            className="btn"
            style={{ padding: '4px 8px', fontSize: 12 }}
            onClick={handleLogout}
            aria-label="Cerrar sesión"
          >
            <i className="ti ti-logout" aria-hidden="true" />
          </button>
        </div>
      </nav>

      {/* Contenido */}
      <main style={{ padding: 14, maxWidth: 700, margin: '0 auto' }}>
        <Outlet />
      </main>

      {/* Bottom nav — fijo abajo en móvil */}
      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: '#fff', borderTop: '0.5px solid #e0dfd8',
        display: 'flex', alignItems: 'center',
        height: 60, zIndex: 50,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              textDecoration: 'none',
              color: isActive ? '#1D9E75' : '#aaa',
              fontSize: 10,
              fontWeight: isActive ? 500 : 400,
              padding: '6px 0',
              borderTop: isActive ? '2px solid #1D9E75' : '2px solid transparent',
            })}
          >
            <i className={`ti ${item.icon}`} style={{ fontSize: 20 }} aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
