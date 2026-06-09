import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom'
import { useSession } from './SessionContext'

function ini(n, a) { return ((n?.[0] || '') + (a?.[0] || '')).toUpperCase() }

export default function Layout() {
  const { player, logout } = useSession()
  const navigate = useNavigate()

  function handleLogout() { logout(); navigate('/auth') }

  const navItems = [
    { to: '/',           label: 'Ranking',    icon: 'ti-trophy'    },
    { to: '/desafios',   label: 'Desafíos',   icon: 'ti-sword'     },
    { to: '/canchas',    label: 'Canchas',    icon: 'ti-tennis'    },
    { to: '/resultados', label: 'Resultados', icon: 'ti-chart-bar' },
    { to: '/reglamento', label: 'Bases',      icon: 'ti-book'      },
  ]
  if (player?.es_admin) navItems.push({ to: '/admin', label: 'Admin', icon: 'ti-settings' })

  return (
    <div style={{ minHeight: '100vh', background: '#f5f4f0' }}>
      {/* Top nav */}
      <nav style={{
        display: 'flex', alignItems: 'center', background: '#fff',
        borderBottom: '0.5px solid #e0dfd8', padding: '0 12px',
        height: 50, position: 'sticky', top: 0, zIndex: 50,
        overflowX: 'auto', gap: 2,
      }}>
        <Link to="/" style={{ textDecoration: 'none', color: 'inherit', fontWeight: 500, fontSize: 15, display: 'flex', alignItems: 'center', gap: 6, marginRight: 6, flexShrink: 0 }}>
          <i className="ti ti-tennis" style={{ fontSize: 16, color: '#1D9E75' }} aria-hidden="true" />
          BOA
        </Link>

        {navItems.map(item => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px', borderRadius: 8, textDecoration: 'none',
              fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0,
              color: isActive ? '#1D9E75' : '#666',
              background: isActive ? '#E1F5EE' : 'transparent',
              fontWeight: isActive ? 500 : 400,
            })}>
            <i className={`ti ${item.icon}`} style={{ fontSize: 15 }} aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {player?.lesionado && <span className="badge badge-red" style={{ fontSize: 10 }}>Lesionado</span>}
          <Link to="/perfil" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{ini(player?.nombre, player?.apellido)}</div>
          </Link>
          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} onClick={handleLogout} aria-label="Cerrar sesión">
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
