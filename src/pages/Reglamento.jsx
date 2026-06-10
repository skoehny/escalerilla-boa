export default function Reglamento() {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>
        <i className="ti ti-book" style={{ verticalAlign: -2, marginRight: 6, color: '#1D9E75' }} aria-hidden="true" />
        Bases de la Escalerilla BOA
      </div>

      <Rule n="1" title="Sistema de ranking y desafíos">
        <p>El ranking es una lista ordenada de jugadores según su nivel demostrado en cancha. Solo puntúa ganar partidos, no los games por partido.</p>
        <p style={{ marginTop: 8 }}><strong>Rango de desafío:</strong> Puedes desafiar hasta 3 posiciones por encima. Si hay jugadores lesionados dentro de ese rango, el rango se amplía para siempre tener 3 rivales disponibles.</p>
        <p style={{ marginTop: 8 }}><strong>Wild Card:</strong> Cada jugador tiene 1 Wild Card por año (se resetea el 1 de enero) que permite desafiar a cualquier posición por encima, sin límite de rango.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiante:</strong> Sube a la posición del derrotado. El derrotado y todos los jugadores entre ambos bajan una posición. El ranking se actualiza cada jueves.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiado:</strong> El ranking no se mueve.</p>
        <p style={{ marginTop: 8 }}><strong>Solo 1 desafío activo</strong> por jugador a la vez. Un jugador no puede desafiar ni ser desafiado si ya tiene un partido activo o jugó en la semana en curso.</p>
      </Rule>

      <Rule n="2" title="Normas de juego">
        <p><strong>Sede:</strong> Todos los partidos deben jugarse en las canchas del Club BOA.</p>
        <p style={{ marginTop: 8 }}><strong>Formato:</strong> Set largo a 9 games. El primero en llegar a 9 gana.</p>
        <p style={{ marginTop: 8 }}><strong>Empate 8-8:</strong> Se define con Tie-break a 7 puntos (con diferencia mínima de 2).</p>
        <p style={{ marginTop: 8 }}><strong>Resultado 9-8:</strong> Se considera tie-break y debe registrarse el marcador del tie-break.</p>
        <p style={{ marginTop: 8 }}><strong>Costos:</strong> El arriendo de cancha ($8.000 pp · 90 min) se divide en partes iguales entre ambos jugadores.</p>
        <p style={{ marginTop: 8 }}><strong>Inscripción:</strong> $15.000 — incluye premios y asado.</p>
      </Rule>

      <Rule n="3" title="Plazos y ciclo semanal">
        <p><strong>48 horas</strong> para confirmar o rechazar un desafío.</p>
        <p style={{ marginTop: 8 }}><strong>1 partido máximo</strong> por semana. El ciclo cierra el miércoles y el ranking se actualiza automáticamente el jueves a las 11:59am.</p>
        <p style={{ marginTop: 8 }}><strong>Reagendamiento:</strong> Si un partido no se jugó antes del cierre y ambos jugadores siguen en rango, se reagenda automáticamente al próximo miércoles. Solo se puede reagendar 1 vez — si tampoco se juega, el desafío caduca.</p>
        <p style={{ marginTop: 8 }}><strong>Rechazos:</strong> Máximo 2 rechazos por mes.</p>
      </Rule>

      <Rule n="4" title="Inactividad">
        <p>La inactividad aplica a todos los jugadores por igual, independiente de si están lesionados o no.</p>
        <p style={{ marginTop: 8 }}><strong>Primera semana sin jugar</strong> (más de 12 días desde la última actualización): baja <strong>2 posiciones</strong>.</p>
        <p style={{ marginTop: 8 }}><strong>Cada semana adicional</strong> sin jugar: baja <strong>1 posición</strong> más.</p>
        <p style={{ marginTop: 8 }}><strong>Para recuperarse:</strong> La penalidad se detiene cuando el jugador juega y registra el resultado de su partido.</p>
      </Rule>

      <Rule n="5" title="W.O. (Walkover)">
        <p>Se declara W.O. en los siguientes casos:</p>
        <p style={{ marginTop: 8 }}>• El partido se cancela con <strong>menos de 24 horas</strong> de anticipación sin acuerdo mutuo.</p>
        <p style={{ marginTop: 8 }}>• Si ambos jugadores acuerdan cancelar con menos de 24 horas, <strong>no hay W.O.</strong> — el partido se cancela limpio.</p>
        <p style={{ marginTop: 8 }}><strong>Resultado W.O.:</strong> El responsable pierde <strong>9-0</strong> y el ranking se mueve como si se hubiera jugado normalmente.</p>
        <p style={{ marginTop: 8 }}>Cancelaciones con <strong>más de 24 horas</strong>: se reagenda (si ambos siguen en rango) o se cancela limpio.</p>
      </Rule>

      <Rule n="6" title="Lesiones">
        <p>Cada jugador puede marcarse como lesionado desde su perfil. Mientras esté lesionado:</p>
        <p style={{ marginTop: 8 }}>• No puede recibir desafíos.</p>
        <p style={{ marginTop: 8 }}>• <strong>Sigue acumulando inactividad</strong> — la lesión no exime de la penalidad por no jugar.</p>
        <p style={{ marginTop: 8 }}>El mismo jugador puede darse de alta desde su perfil cuando se recupere.</p>
      </Rule>

      <Rule n="7" title="Registro de resultados">
        <p>Cualquiera de los dos jugadores puede registrar el resultado una vez que haya pasado la hora del partido. Para registrar se requiere:</p>
        <p style={{ marginTop: 8 }}>• Cancha, fecha y hora asignadas.</p>
        <p style={{ marginTop: 8 }}>• Pago confirmado por el administrador.</p>
        <p style={{ marginTop: 8 }}>El rival puede <strong>editar</strong> el resultado si no está de acuerdo. Cualquiera puede <strong>validarlo</strong> para dejarlo definitivo. Si hay discrepancia, el administrador resuelve.</p>
      </Rule>

      <div style={{ background: '#E1F5EE', border: '0.5px solid #5DCAA5', borderRadius: 8, padding: '10px 12px', marginTop: 10, fontSize: 12, color: '#085041' }}>
        <i className="ti ti-info-circle" style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden="true" />
        Cualquier situación no contemplada en estas bases será resuelta por el administrador del torneo.
      </div>
    </div>
  )
}

function Rule({ n, title, children }) {
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#1D9E75', color: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 500, flexShrink: 0 }}>
          {n}
        </div>
        <span style={{ fontSize: 14, fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ fontSize: 13, color: '#555', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}
