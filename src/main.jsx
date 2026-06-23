import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'

import Auth        from './pages/Auth'
import Ranking     from './pages/Ranking'
import Desafios    from './pages/Desafios'
import Resultados  from './pages/Resultados'
import Admin       from './pages/Admin'
import Perfil      from './pages/Perfil'
import JugadorPerfil from './pages/JugadorPerfil'
import Reglamento  from './pages/Reglamento'
import Layout      from './components/Layout'
import AutoRefresh from './components/AutoRefresh'
import { SessionProvider, useSession } from './components/SessionContext'

function ProtectedRoute({ children }) {
  const { player } = useSession()
  return player ? children : <Navigate to="/auth" replace />
}

function AdminRoute({ children }) {
  const { player } = useSession()
  if (!player) return <Navigate to="/auth" replace />
  if (!player.es_admin) return <Navigate to="/" replace />
  return children
}

function AppRoutes() {
  const { player } = useSession()
  return (
    <Routes>
      <Route path="/auth" element={player ? <Navigate to="/" replace /> : <Auth />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Ranking />} />
        <Route path="desafios"   element={<Desafios />} />
        <Route path="resultados" element={<Resultados />} />
        <Route path="perfil"     element={<Perfil />} />
        <Route path="jugador/:id" element={<JugadorPerfil />} />
        <Route path="reglamento" element={<Reglamento />} />
        <Route path="admin"      element={<AdminRoute><Admin /></AdminRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <AutoRefresh />
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>
)
