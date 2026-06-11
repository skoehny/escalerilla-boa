// src/lib/notify.js
// Comparte mensaje via navigator.share (celular) o copia al portapapeles (PC)

const APP_URL = 'https://escalerilla-boa.vercel.app'

function shareMsg(msg) {
  try {
    if (navigator.share) navigator.share({ text: msg })
    else navigator.clipboard.writeText(msg)
  } catch (e) {
    console.warn('No se pudo compartir:', e)
  }
}

const nm = p => `${p?.nombre || ''} ${p?.apellido || ''}`.trim()

export function notifyChallengeSent(challenger, challenged) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n⚔️ ${nm(challenger)} (#${challenger.posicion}) desafía a ${nm(challenged)} (#${challenged.posicion})\n\nVer desafíos: ${APP_URL}`)
}

export function notifyChallengeAccepted(challenger, challenged, deadline) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n✅ ${nm(challenged)} aceptó el desafío de ${nm(challenger)}\nFecha límite: ${deadline}\n\nCoordinen el día y reserven cancha en: ${APP_URL}`)
}

export function notifyChallengeRejected(challenger, challenged) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n❌ ${nm(challenged)} rechazó el desafío de ${nm(challenger)}\n\nVer ranking: ${APP_URL}`)
}

export function notifySlotReserved(challenger, challenged, court, day, hour) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n📅 Partido programado\n${nm(challenger)} vs ${nm(challenged)}\n${court} · ${day} · ${hour}\n\nVer en app: ${APP_URL}`)
}

export function notifyPaymentConfirmed(challenger, challenged, court, day, hour) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n💳 Pago confirmado\n${nm(challenger)} vs ${nm(challenged)}\n${court} · ${day} · ${hour}\n¡Listo para jugar!\n\nVer en app: ${APP_URL}`)
}

export function notifyResult(challenger, challenged, scoreA, scoreB, winner) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n✅ Resultado\n${nm(challenger)} ${scoreA}–${scoreB} ${nm(challenged)}\n🏆 Gana: ${nm(winner)}\n\nVer resultados: ${APP_URL}`)
}

export function notifyRankingUpdated(semana, top5) {
  const lista = (top5 || []).map((p, i) => `${i + 1}. ${nm(p)}`).join('\n')
  shareMsg(`🎾 *Escalerilla BOA — Ranking Semana ${semana}*\n\n🏆 Top 5:\n${lista}\n\nVer ranking completo: ${APP_URL}`)
}

export function notifyReminder(matches) {
  const lista = (matches || []).map(m => `• ${m.a} vs ${m.b}`).join('\n')
  shareMsg(`🎾 *Escalerilla BOA — Recordatorio*\n\nPartidos pendientes esta semana:\n${lista}\n\n⏰ Fecha límite: miércoles\nVer en app: ${APP_URL}`)
}

export function notifyChallengeExpired(challenger, challenged) {
  shareMsg(`🎾 *Escalerilla BOA*\n\n⌛ Desafío caducado\n${nm(challenger)} vs ${nm(challenged)}\n\nVer ranking: ${APP_URL}`)
}
