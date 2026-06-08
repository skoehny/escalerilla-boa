import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'

import Auth    from './pages/Auth'
import Ranking from './pages/Ranking'
import Desafios from './pages/Desafios'
import Canchas  from './pages/Canchas'
import Resultados from './pages/Resultados'
import Admin   from './pages/Admin'
import Layout  from './components/Layout'
import { useSession } from './components/SessionContext'
import { SessionProvider } from './components/SessionContext'

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
        <Route path="desafios" element={<Desafios />} />
        <Route path="canchas" element={<Canchas />} />
        <Route path="resultados" element={<Resultados />} />
        <Route path="admin" element={<AdminRoute><Admin /></AdminRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>
)
