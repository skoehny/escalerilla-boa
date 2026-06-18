import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 70

async function hardRefresh() {
  try {
    const keys = await caches.keys()
    await Promise.all(keys.map(k => caches.delete(k)))
  } finally {
    window.location.reload()
  }
}

export default function PullToRefresh() {
  const [display, setDisplay] = useState({ pullY: 0, triggered: false })
  const s = useRef({ startY: null, startX: null, active: false, pulling: false, pullY: 0 })

  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY > 0) return
      s.current.startY = e.touches[0].clientY
      s.current.startX = e.touches[0].clientX
      s.current.active = true
      s.current.pulling = false
      s.current.pullY = 0
    }

    function onTouchMove(e) {
      if (!s.current.active) return
      const dy = e.touches[0].clientY - s.current.startY
      const dx = e.touches[0].clientX - s.current.startX

      if (!s.current.pulling) {
        // Cancelar si va hacia arriba o es más horizontal que vertical
        if (dy < 0 || Math.abs(dx) > dy) { s.current.active = false; return }
        // Zona muerta: esperar 10px antes de confirmar el gesto
        if (dy < 10) return
        s.current.pulling = true
      }

      // Solo aquí se llama preventDefault — gesto confirmado como pull
      e.preventDefault()
      s.current.pullY = Math.min(dy, THRESHOLD * 1.5)
      setDisplay(d => ({ ...d, pullY: s.current.pullY }))
    }

    function onTouchEnd() {
      if (!s.current.active) return
      s.current.active = false
      if (s.current.pulling && s.current.pullY >= THRESHOLD) {
        setDisplay({ pullY: THRESHOLD, triggered: true })
        hardRefresh()
      } else {
        s.current.pullY = 0
        s.current.pulling = false
        setDisplay({ pullY: 0, triggered: false })
      }
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

  const { pullY, triggered } = display
  if (pullY === 0 && !triggered) return null

  const progress = Math.min(pullY / THRESHOLD, 1)
  const ready = triggered || pullY >= THRESHOLD

  return (
    <>
      <style>{`@keyframes ptr-spin { to { transform: rotate(360deg) } }`}</style>
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none',
        transform: `translateY(${Math.min(pullY, THRESHOLD) - 44}px)`,
        transition: pullY === 0 ? 'transform 0.25s ease' : 'none',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: progress,
        }}>
          {triggered
            ? <div style={{
                width: 18, height: 18, borderRadius: '50%',
                border: '2.5px solid #E1F5EE',
                borderTopColor: '#1D9E75',
                animation: 'ptr-spin 0.7s linear infinite',
              }} />
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke={ready ? '#1D9E75' : '#888'} strokeWidth="2.5"
                style={{ transform: `rotate(${progress * 270}deg)`, transition: 'transform 0.1s' }}>
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
              </svg>
          }
        </div>
      </div>
    </>
  )
}
