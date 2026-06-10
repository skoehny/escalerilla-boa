// src/lib/notify.js
// Abre WhatsApp con mensaje pre-escrito — el usuario decide si enviar y a quién

const APP_URL = 'https://escalerilla-boa.vercel.app'

function openWA(msg) {
  try {
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  } catch (e) {
    console.warn('No se pudo abrir WA:', e)
  }
}

export function notifyChallengeSent(challenger, challenged) {
  openWA(`🎾 *Escalerilla BOA*\n\n⚔️ ${challenger.nombre} ${challenger.apellido} (#${challenger.posicion}) desafía a ${challenged.nombre} ${challenged.apellido} (#${challenged.posicion})\n\nVer desafíos: ${APP_URL}`)
}

export function notifyChallengeAccepted(challenger, challenged, deadline) {
  openWA(`🎾 *Escalerilla BOA*\n\n✅ ${challenged.nombre} ${challenged.apellido} aceptó el desafío de ${challenger.nombre} ${challenger.apellido}\nFecha límite: ${deadline}\n\nCoordinen el día por aquí y reserven cancha en: ${APP_URL}`)
}

export function notifyChallengeRejected(challenger, challenged) {
  openWA(`🎾 *Escalerilla BOA*\n\n❌ ${challenged.nombre} ${challenged.apellido} rechazó el desafío de ${challenger.nombre} ${challenger.apellido}\n\nVer ranking: ${APP_URL}`)
}

export function notifySlotReserved(challenger, challenged, court, day, hour) {
  openWA(`🎾 *Escalerilla BOA*\n\n📅 Partido programado\n${challenger.nombre} vs ${challenged.nombre}\n${court} · ${day} · ${hour}\n\nVer en app: ${APP_URL}`)
}

export function notifyPaymentConfirmed(challenger, challenged, court, day, hour) {
  openWA(`🎾 *Escalerilla BOA*\n\n💳 Pago confirmado\n${challenger.nombre} vs ${challenged.nombre}\n${court} · ${day} · ${hour}\n¡Listo para jugar!\n\nVer en app: ${APP_URL}`)
}

export function notifyResult(challenger, challenged, scoreA, scoreB, winner) {
  const tb = ''
  openWA(`🎾 *Escalerilla BOA*\n\n✅ Resultado\n${challenger?.nombre} ${scoreA}–${scoreB}${tb} ${challenged?.nombre}\n🏆 Gana: ${winner?.nombre} ${winner?.apellido}\n\nVer resultados: ${APP_URL}`)
}

export function notifyRankingUpdated(semana, top5) {
  const lista = (top5 || []).map((p, i) => `${i + 1}. ${p.nombre} ${p.apellido}`).join('\n')
  openWA(`🎾 *Escalerilla BOA — Ranking Semana ${semana}*\n\n🏆 Top 5:\n${lista}\n\nVer ranking completo: ${APP_URL}`)
}

export function notifyReminder(matches) {
  const lista = (matches || []).map(m => `• ${m.a} vs ${m.b}`).join('\n')
  openWA(`🎾 *Escalerilla BOA — Recordatorio*\n\nPartidos pendientes esta semana:\n${lista}\n\n⏰ Fecha límite: miércoles\nVer en app: ${APP_URL}`)
}

export function notifyChallengeExpired(challenger, challenged) {
  openWA(`🎾 *Escalerilla BOA*\n\n⌛ Desafío caducado\n${challenger.nombre} vs ${challenged.nombre}\n\nVer ranking: ${APP_URL}`)
}
