import { useEffect } from 'react'

// Recarga la app cuando el usuario vuelve después de estar ausente un rato.
// Con una sola recarga se logra: datos frescos + última versión deployada
// + revalidación del jugador. La sesión vive en localStorage, así que
// nadie tiene que volver a iniciar sesión.
const AWAY_MINUTES = 10

export default function AutoRefresh() {
  useEffect(() => {
    let hiddenAt = null
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
      } else if (hiddenAt && Date.now() - hiddenAt > AWAY_MINUTES * 60 * 1000) {
        window.location.reload()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  return null
}
