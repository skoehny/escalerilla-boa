export default function Reglamento() {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>
        <i className="ti ti-book" style={{ verticalAlign: -2, marginRight: 6, color: '#1D9E75' }} aria-hidden="true" />
        Bases de la Escalerilla BOA
      </div>

      <Rule n="1" title="Sistema de ranking y desafíos">
        <p>El ranking es una lista ordenada de jugadores según su nivel demostrado en cancha. Solo puntúa ganar partidos, no los games por partido.</p>
        <p style={{ marginTop: 8 }}><strong>Rango de desafío:</strong> Puedes desafiar hasta 5 posiciones por encima. Los jugadores lesionados no pueden ser desafiados.</p>
        <p style={{ marginTop: 8 }}><strong>Wild Card:</strong> Cada jugador tiene 1 Wild Card por año (se resetea el 1 de enero) que permite desafiar a cualquier posición por encima, sin límite de rango.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiante:</strong> Sube a la posición del derrotado. El derrotado y todos los jugadores entre ambos bajan una posición. <strong>El ranking se actualiza al instante</strong>, apenas se registra el resultado.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiado:</strong> El ranking no se mueve.</p>
        <p style={{ marginTop: 8 }}><strong>Solo 1 desafío activo</strong> por jugador a la vez: no puedes desafiar ni ser desafiado si ya tienes un desafío pendiente o aceptado.</p>
      </Rule>

      <Rule n="2" title="Normas de juego">
        <p><strong>Sede:</strong> Todos los partidos deben jugarse en las canchas del Club BOA.</p>
        <p style={{ marginTop: 8 }}><strong>Formato:</strong> Set largo a 9 games. El primero en llegar a 9 gana.</p>
        <p style={{ marginTop: 8 }}><strong>Empate 8-8:</strong> Se define con Tie-break a 7 puntos (con diferencia mínima de 2).</p>
        <p style={{ marginTop: 8 }}><strong>Resultado 9-8:</strong> Se considera tie-break y debe registrarse el marcador del tie-break.</p>
        <p style={{ marginTop: 8 }}><strong>Costos:</strong> El arriendo de cancha ($8.000 pp · 90 min) se divide en partes iguales entre ambos jugadores.</p>
        <p style={{ marginTop: 8 }}><strong>Inscripción:</strong> $15.000 — incluye premios y asado.</p>
      </Rule>

      <Rule n="3" title="Plazos y expiración">
        <p><strong>Expiración:</strong> un desafío expira automáticamente a los <strong>7 días</strong> de creado si no se juega.</p>
        <p style={{ marginTop: 8 }}><strong>Ranking en vivo:</strong> el ranking se actualiza al instante con cada resultado. Ya no hay publicación manual.</p>
        <p style={{ marginTop: 8 }}><strong>Foto semanal:</strong> cada jueves se genera automáticamente una foto del ranking, con las flechas de la semana y un resumen compartible.</p>
        <p style={{ marginTop: 8 }}><strong>Rechazos:</strong> Máximo 2 rechazos por mes.</p>
      </Rule>

      <Rule n="4" title="Inactividad">
        <p>La inactividad aplica a todos los jugadores por igual, estén lesionados o no. Lo único que cuenta es haber jugado y registrado un partido.</p>
        <p style={{ marginTop: 8 }}><strong>2 semanas sin jugar:</strong> baja <strong>2 posiciones</strong>.</p>
        <p style={{ marginTop: 8 }}><strong>Cada semana adicional</strong> sin jugar: baja <strong>1 posición</strong> más.</p>
        <p style={{ marginTop: 8 }}>La intención de jugar (haber enviado o aceptado un desafío) <strong>no exime</strong> de la penalización: si el partido no se jugó, se aplica el descuento igual.</p>
        <p style={{ marginTop: 8 }}><strong>Única excepción:</strong> si en la primera semana penalizable no tenías ningún rival disponible por encima (todos lesionados u ocupados en otro partido), esa semana no se penaliza. Desde la siguiente, la penalización aplica normalmente.</p>
        <p style={{ marginTop: 8 }}><strong>Para recuperarse:</strong> la penalización se detiene cuando el jugador juega y registra el resultado de su partido.</p>
      </Rule>

      <Rule n="5" title="Cancelación de desafíos">
        <p>Un desafío puede cancelarse en cualquier momento antes de jugarse. Al cancelar, se debe indicar el <strong>motivo</strong>: sin respuesta del rival, no se pudo acordar horario, lesión, acuerdo mutuo, u otro.</p>
        <p style={{ marginTop: 8 }}>Al cancelar un desafío en la semana en curso, <strong>ambos jugadores quedan libres</strong> para enviar o recibir un nuevo desafío esa misma semana.</p>
        <p style={{ marginTop: 8 }}>La cancelación no implica penalización por sí misma, pero si ninguno de los dos jugó esa semana, corre la regla de inactividad normalmente.</p>
      </Rule>

      <Rule n="6" title="W.O. (Walkover)">
        <p>Se declara W.O. en los siguientes casos:</p>
        <p style={{ marginTop: 8 }}>• El partido se cancela con <strong>menos de 24 horas</strong> de anticipación sin acuerdo mutuo.</p>
        <p style={{ marginTop: 8 }}>• Si ambos jugadores acuerdan cancelar con menos de 24 horas, <strong>no hay W.O.</strong> — el partido se cancela limpio.</p>
        <p style={{ marginTop: 8 }}><strong>Resultado W.O.:</strong> El responsable pierde <strong>9-0</strong> y el ranking se mueve como si se hubiera jugado normalmente.</p>
        <p style={{ marginTop: 8 }}>Cancelaciones con <strong>más de 24 horas</strong>: se reagenda (si ambos siguen en rango) o se cancela limpio.</p>
      </Rule>

      <Rule n="7" title="Lesiones">
        <p>Cada jugador puede marcarse como lesionado desde su perfil. Mientras esté lesionado:</p>
        <p style={{ marginTop: 8 }}>• No puede recibir desafíos.</p>
        <p style={{ marginTop: 8 }}>• <strong>Sigue acumulando inactividad</strong> — la lesión no exime de la penalidad por no jugar.</p>
        <p style={{ marginTop: 8 }}>El mismo jugador puede darse de alta desde su perfil cuando se recupere.</p>
      </Rule>

      <Rule n="8" title="Registro de resultados">
        <p>Cualquiera de los dos jugadores puede registrar el resultado de un partido aceptado.</p>
        <p style={{ marginTop: 8 }}><strong>Datos obligatorios:</strong> para guardar un resultado es obligatorio indicar cancha, fecha, hora y marcador. Sin todos esos datos no se puede guardar (aplica también al administrador).</p>
        <p style={{ marginTop: 8 }}><strong>Si jugaron sin que el rival aceptara por la app:</strong> el desafiante puede usar la opción "Jugamos" para registrar el resultado directamente, completando todos los datos.</p>
        <p style={{ marginTop: 8 }}><strong>Validar y corregir (ventana de 24 horas):</strong> apenas se registra un resultado el ranking se mueve al instante. Durante las <strong>24 horas</strong> siguientes, cualquiera de los dos jugadores puede <strong>Validar</strong> el resultado (lo deja definitivo) o <strong>Corregir</strong> el marcador (revierte y reaplica el ranking automáticamente). Pasada esa ventana, o si ya fue validado, solo el administrador puede corregir.</p>
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
