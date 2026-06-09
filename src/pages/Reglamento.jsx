export default function Reglamento() {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>
        <i className="ti ti-book" style={{ verticalAlign: -2, marginRight: 6, color: '#1D9E75' }} aria-hidden="true" />
        Bases de la Escalerilla BOA
      </div>

      <Rule n="1" title="Sistema de ranking y desafíos">
        <p>El ranking es una lista ordenada de jugadores según su nivel demostrado en cancha. Solo puntúa ganar partidos, no los games por partido.</p>
        <p style={{ marginTop: 8 }}><strong>Rango de desafío:</strong> Puedes desafiar a cualquier jugador hasta 3 puestos por encima del tuyo (ej: el #8 puede desafiar al #7, #6 o #5).</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiante:</strong> Sube a la posición del derrotado. El derrotado y todos los jugadores entre ambos bajan una posición.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiado:</strong> El ranking no se mueve.</p>
        <p style={{ marginTop: 8 }}><strong>Solo 1 desafío activo</strong> por jugador a la vez, ya sea como desafiante o desafiado.</p>
      </Rule>

      <Rule n="2" title="Normas de juego">
        <p><strong>Sede:</strong> Todos los partidos deben jugarse en las canchas del Club BOA.</p>
        <p style={{ marginTop: 8 }}><strong>Formato:</strong> Set largo a 9 games. El primero en llegar a 9 gana.</p>
        <p style={{ marginTop: 8 }}><strong>Empate 8-8:</strong> Se define con Tie-break a 7 puntos (con diferencia de 2).</p>
        <p style={{ marginTop: 8 }}><strong>Costos:</strong> El arriendo de cancha ($8.000 pp · 90 min) se divide en partes iguales entre ambos jugadores.</p>
        <p style={{ marginTop: 8 }}><strong>Inscripción:</strong> $15.000 — incluye premios y asado.</p>
      </Rule>

      <Rule n="3" title="Plazos y compromiso">
        <p><strong>48 horas</strong> para confirmar o rechazar un desafío.</p>
        <p style={{ marginTop: 8 }}><strong>1 partido máximo</strong> por semana. El ciclo cierra el miércoles y el ranking se actualiza el jueves.</p>
        <p style={{ marginTop: 8 }}><strong>Inactividad:</strong> Si un jugador no juega en 2 semanas seguidas, baja 2 posiciones en la actualización del jueves.</p>
        <p style={{ marginTop: 8 }}><strong>Rechazos:</strong> Máximo 2 rechazos por mes. Al tercer rechazo sin causa justificada, se declara W.O. y el desafiante gana el puesto.</p>
      </Rule>

      <Rule n="4" title="W.O. (Walkover)">
        <p>Si el desafiado rechaza 3 desafíos consecutivos sin causa de fuerza mayor, se declara W.O. automático. El desafiante gana los puntos y el puesto como si se hubiera jugado el partido.</p>
      </Rule>

      <Rule n="5" title="Lesiones">
        <p>Un jugador lesionado puede ser marcado como tal por el administrador. Mientras esté lesionado, no puede recibir desafíos. Al recuperarse, el admin lo da de alta y vuelve a estar disponible.</p>
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
