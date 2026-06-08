// src/lib/notify.js
// Llama al endpoint de Twilio desde el frontend

export async function notify(event, data) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data }),
    })
  } catch (err) {
    // Notificación fallida no debe romper el flujo principal
    console.warn('Notificación WA falló:', err)
  }
}

// Helpers con firma tipada para cada evento

export const notifyChallengeSent = (challenger, challenged) =>
  notify('challenge_sent', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challengerPos: challenger.posicion,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
    challengedPos: challenged.posicion,
  })

export const notifyChallengeAccepted = (challenger, challenged, deadline) =>
  notify('challenge_accepted', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
    deadline,
  })

export const notifyChallengeRejected = (challenger, challenged) =>
  notify('challenge_rejected', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
  })

export const notifySlotReserved = (challenger, challenged, court, day, hour) =>
  notify('slot_reserved', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
    court, day, hour,
  })

export const notifyPaymentConfirmed = (challenger, challenged, court, day, hour) =>
  notify('payment_confirmed', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
    court, day, hour,
  })

export const notifyResult = (challenger, challenged, scoreA, scoreB, winner, newPos) =>
  notify('result_saved', {
    challengerName: `${challenger.nombre} ${challenger.apellido}`,
    challengedName: `${challenged.nombre} ${challenged.apellido}`,
    scoreA, scoreB,
    winner: `${winner.nombre} ${winner.apellido}`,
    rankChange: !!newPos,
    newPos,
  })

export const notifyRankingUpdated = (semana, top5) =>
  notify('ranking_updated', { semana, top5 })

export const notifyReminder = (matches) =>
  notify('reminder_wednesday', { matches })

export const notifyChallengeExpired = (challenger, challenged) =>
  notify('challenge_expired', {
    challenger: `${challenger.nombre} ${challenger.apellido}`,
    challenged: `${challenged.nombre} ${challenged.apellido}`,
  })
