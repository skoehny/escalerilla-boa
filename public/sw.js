// Service Worker mínimo — Escalerilla BOA
// Estrategia: network first (siempre la última versión), cache como fallback
const CACHE = 'escalerilla-v1'

self.addEventListener('install', e => {
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  // Solo cachear GETs, no las llamadas a Supabase
  if (e.request.method !== 'GET') return
  if (e.request.url.includes('supabase')) return

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(e.request, clone))
        return res
      })
      .catch(() => caches.match(e.request))
  )
})
