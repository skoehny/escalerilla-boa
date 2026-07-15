import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import PelotaTenis from '../components/PelotaTenis'
import { FORMATOS } from '../lib/formato'

export default function Reglamento() {
  const [clubName, setClubName] = useState('Club BOA')
  const [formato, setFormato] = useState('set9')
  useEffect(() => {
    supabase.from('v2_config').select('nombre_club, formato_partido').eq('id', 1).single()
      .then(({ data }) => { if (data?.nombre_club) setClubName(data.nombre_club); if (data?.formato_partido) setFormato(data.formato_partido) })
  }, [])
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>
        <i className="ti ti-book" style={{ verticalAlign: -2, marginRight: 6, color: '#1D9E75' }} aria-hidden="true" />
        Bases de la Escalerilla<PelotaTenis size={18} />
      </div>

      <Rule n="1" title="Sistema de ranking y desafíos">
        <p>El ranking es una lista ordenada de jugadores según su nivel demostrado en cancha. Solo puntúa ganar partidos, no los games por partido.</p>
        <p style={{ marginTop: 8 }}><strong>Rango de desafío:</strong> Puedes desafiar hasta 4 posiciones por encima (el rango lo define la administración y puede ajustarse). Los jugadores lesionados no pueden ser desafiados.</p>
        <p style={{ marginTop: 8 }}><strong>Wild Card:</strong> Cada jugador tiene 1 Wild Card por año (se resetea el 1 de enero) que permite desafiar a cualquier posición por encima, sin límite de rango.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiante:</strong> Sube a la posición del derrotado. El derrotado y todos los jugadores entre ambos bajan una posición. <strong>El ranking se actualiza al instante</strong>, apenas se registra el resultado.</p>
        <p style={{ marginTop: 8 }}><strong>Si gana el desafiado:</strong> El ranking no se mueve.</p>
        <p style={{ marginTop: 8 }}><strong>Solo 1 desafío activo</strong> por jugador a la vez: no puedes desafiar ni ser desafiado si ya tienes un desafío pendiente o aceptado.</p>
      </Rule>

      <Rule n="2" title="Normas de juego">
        <p><strong>Sede:</strong> Todos los partidos deben jugarse en las canchas del {clubName}.</p>
        <p style={{ marginTop: 8 }}><strong>Formato ({FORMATOS[formato]?.label}):</strong> {FORMATOS[formato]?.regla}</p>
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
        <p>El reloj de inactividad cuenta los días sin jugar desde tu último partido registrado.</p>
        <p style={{ marginTop: 8 }}><strong>Pausa:</strong> mientras tengas un desafío activo (pendiente o aceptado) el reloj se pausa; esos días no se cuentan. Al expirar o cancelarse sin jugar, el reloj se reanuda donde iba.</p>
        <p style={{ marginTop: 8 }}><strong>Penalizaciones</strong> (por días efectivos sin jugar):</p>
        <p style={{ marginTop: 4 }}>• <strong>14 días:</strong> bajas <strong>2 posiciones</strong>.</p>
        <p style={{ marginTop: 4 }}>• <strong>21 días:</strong> bajas <strong>1 posición</strong> más.</p>
        <p style={{ marginTop: 4 }}>• <strong>28 días:</strong> bajas <strong>1 posición</strong> más y quedas marcado como <strong>lesionado</strong>.</p>
        <p style={{ marginTop: 4 }}>• Cada 7 días adicionales: <strong>1 posición</strong> más.</p>
        <p style={{ marginTop: 8 }}>Ningún jugador cae por debajo de otro que también esté inactivo (14+ días) ni de un debutante.</p>
        <p style={{ marginTop: 8 }}><strong>Debutantes:</strong> no tienen reloj hasta jugar su primer partido; recién ahí empieza a contar.</p>
        <p style={{ marginTop: 8 }}><strong>Para recuperarse:</strong> el reloj se reinicia cuando juegas y registras un resultado.</p>
      </Rule>

      <Rule n="5" title="Cancelación de desafíos">
        <p>Un desafío puede cancelarse en cualquier momento antes de jugarse, indicando el <strong>motivo</strong>. Al cancelar, ambos jugadores quedan libres de inmediato para enviar o recibir un nuevo desafío.</p>
        <p style={{ marginTop: 8 }}><strong>Cancelación tardía:</strong> si cancelas un desafío con cancha reservada a menos de 24 horas del horario del partido, el <strong>jugador afectado</strong> (el que no canceló) puede marcarte un <strong>WO</strong> (ver regla 6).</p>
        <p style={{ marginTop: 8 }}>La cancelación no penaliza por sí misma, pero el reloj de inactividad sigue corriendo si no juegas.</p>
      </Rule>

      <Rule n="6" title="W.O. (Walkover)">
        <p>El WO se comporta como un resultado normal: mueve el ranking y cuenta para tus estadísticas. El responsable pierde <strong>9-0</strong>.</p>
        <p style={{ marginTop: 8 }}><strong>Sin cancha reservada:</strong> en un desafío pendiente o aceptado sin cancha, cualquiera de los dos jugadores puede marcar WO (gana 9-0 quien lo marca).</p>
        <p style={{ marginTop: 8 }}><strong>Por cancelación tardía:</strong> si el rival canceló un desafío con cancha reservada a menos de 24 horas del partido, el jugador afectado marca el WO a su favor.</p>
        <p style={{ marginTop: 8 }}>Todo WO entra al flujo normal: durante las <strong>24 horas</strong> siguientes el rival puede validarlo o corregirlo; pasada la ventana, solo el administrador.</p>
      </Rule>

      <Rule n="7" title="Lesiones">
        <p>Un jugador lesionado <strong>no puede ser desafiado</strong>. El estado de lesión puede marcarlo el propio jugador desde su perfil, o se activa automáticamente a los <strong>28 días</strong> de inactividad.</p>
        <p style={{ marginTop: 8 }}><strong>Volver a la actividad:</strong> crear un desafío te reactiva automáticamente (te quita el estado de lesionado). También puedes darte de alta desde tu perfil.</p>
        <p style={{ marginTop: 8 }}>Mientras estés inactivo, el reloj de inactividad sigue corriendo aunque estés marcado como lesionado.</p>
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
