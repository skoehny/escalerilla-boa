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
    { to: '/',           label: 'Ranking',    icon: 'ti-trophy'       },
    { to: '/desafios',   label: 'Desafíos',   icon: 'ti-sword'        },
    { to: '/canchas',    label: 'Canchas',    icon: 'ti-tennis'       },
    { to: '/resultados', label: 'Resultados', icon: 'ti-chart-bar'    },
  ]
  if (player?.es_admin) {
    navItems.push({ to: '/admin', label: 'Admin', icon: 'ti-settings' })
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f4f0' }}>
      <nav style={{
        display: 'flex', alignItems: 'center',
        background: '#fff', borderBottom: '0.5px solid #e0dfd8',
        padding: '0 14px', height: 52, gap: 2,
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <span style={{ fontWeight: 500, fontSize: 15, marginRight: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-tennis" style={{ fontSize: 15, color: '#1D9E75' }} aria-hidden="true" />
          BOA
        </span>

        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              padding: '6px 9px', borderRadius: 8,
              fontSize: 12, textDecoration: 'none',
              color: isActive ? '#1a1a1a' : '#888',
              background: isActive ? '#f5f4f0' : 'transparent',
              fontWeight: isActive ? 500 : 400,
              whiteSpace: 'nowrap',
            })}
          >
            <i className={`ti ${item.icon}`} style={{ fontSize: 14, verticalAlign: -2, marginRight: 4 }} aria-hidden="true" />
            <span className="hide-mobile">{item.label}</span>
          </NavLink>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {player?.lesionado && (
            <span className="badge badge-red" style={{ fontSize: 10 }}>Lesionado</span>
          )}
          <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>
            {ini(player?.nombre, player?.apellido)}
          </div>
          <span style={{ fontSize: 12, color: '#888' }} className="hide-mobile">
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

      <main style={{ padding: 14, maxWidth: 700, margin: '0 auto' }}>
        <Outlet />
      </main>
    </div>
  )
}
