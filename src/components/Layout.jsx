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
    { to: '/resultados', label: 'Resultados', icon: 'ti-chart-bar' },
    { to: '/reglamento', label: 'Bases',      icon: 'ti-book'      },
  ]
  // Admin canchas solo ve canchas
  if (player?.es_admin_canchas) navItems.splice(1, 0, { to: '/canchas', label: 'Canchas', icon: 'ti-tennis' })
  // Admin full ve canchas también
  if (player?.es_admin) {
    navItems.splice(2, 0, { to: '/canchas', label: 'Canchas', icon: 'ti-tennis' })
    navItems.push({ to: '/admin', label: 'Admin', icon: 'ti-settings' })
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f4f0' }}>
      <div style={{ background: '#fff', borderBottom: '0.5px solid #e0dfd8', position: 'sticky', top: 0, zIndex: 50 }}>

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

      <main style={{ padding: 14, maxWidth: 700, margin: '0 auto' }}>
        <Outlet />
      </main>
    </div>
  )
}