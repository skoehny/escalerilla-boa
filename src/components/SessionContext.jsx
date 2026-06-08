import { createContext, useContext, useState, useEffect } from 'react'

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [player, setPlayer] = useState(() => {
    try {
      const stored = localStorage.getItem('boa_player')
      return stored ? JSON.parse(stored) : null
    } catch { return null }
  })

  function login(playerData) {
    localStorage.setItem('boa_player', JSON.stringify(playerData))
    setPlayer(playerData)
  }

  function logout() {
    localStorage.removeItem('boa_player')
    setPlayer(null)
  }

  function updateSession(updates) {
    const updated = { ...player, ...updates }
    localStorage.setItem('boa_player', JSON.stringify(updated))
    setPlayer(updated)
  }

  return (
    <SessionContext.Provider value={{ player, login, logout, updateSession }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}
