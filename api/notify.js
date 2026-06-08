// api/notify.js — Vercel Serverless Function
// POST /api/notify  { event, data }
// Llamado desde el frontend cada vez que ocurre un evento relevante

const twilio = require('twilio')

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const FROM = process.env.TWILIO_WA_NUMBER
const GROUP = process.env.WA_GROUP_NUMBER
const APP_URL = process.env.VITE_APP_URL || 'https://escalerilla-boa.vercel.app'

function buildMessage(event, data) {
  switch (event) {
    case 'challenge_sent':
      return `⚔️ Nuevo desafío\n${data.challenger} (#${data.challengerPos}) desafió a ${data.challenged} (#${data.challengedPos}).\n${data.challenged} tiene 48 h para responder.`

    case 'challenge_accepted':
      return `✅ Desafío aceptado\n${data.challenged} aceptó el desafío de ${data.challenger}.\nTienen hasta el ${data.deadline} para jugar. Coordinen el día por acá.`

    case 'challenge_rejected':
      return `❌ Desafío rechazado\n${data.challenged} rechazó el desafío de ${data.challenger}.`

    case 'slot_reserved':
      return `🎾 Cancha reservada\n${data.court} · ${data.day} · ${data.hour}\n${data.challenger} vs ${data.challenged} · Pago pendiente.`

    case 'payment_confirmed':
      return `💳 Pago confirmado\n${data.court} · ${data.day} · ${data.hour}\n${data.challenger} vs ${data.challenged} · ¡Listo para jugar!`

    case 'result_saved':
      return `🏆 Resultado\n${data.challengerName} ${data.scoreA} — ${data.scoreB} ${data.challengedName}\n${data.winner} gana${data.rankChange ? ` y sube al #${data.newPos}` : ''}.`

    case 'ranking_updated':
      const top = data.top5.map((p, i) => `${i + 1}. ${p.nombre} ${p.apellido}`).join('\n')
      return `📊 Ranking actualizado — Semana ${data.semana}\n\n${top}\n\nVer completo: ${APP_URL}`

    case 'reminder_wednesday':
      return `⏰ Recordatorio\nMañana es el último día para jugar los partidos pendientes:\n${data.matches.map(m => `• ${m.a} vs ${m.b}`).join('\n')}`

    case 'challenge_expired':
      return `⌛ Desafío caducado\n${data.challenger} vs ${data.challenged} — no se llegó a acuerdo de horario. Ambos quedan libres para nuevos desafíos.`

    default:
      return null
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { event, data } = req.body

  if (!event || !data) {
    return res.status(400).json({ error: 'Missing event or data' })
  }

  const message = buildMessage(event, data)
  if (!message) {
    return res.status(400).json({ error: 'Unknown event type' })
  }

  try {
    await client.messages.create({
      from: FROM,
      to: GROUP,
      body: message,
    })
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('Twilio error:', err)
    return res.status(500).json({ error: err.message })
  }
}
