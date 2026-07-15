import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import PelotaTenis from '../components/PelotaTenis'
import { FORMATOS } from '../lib/formato'

function horasTexto(min) {
  if (min == null) return ''
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`
}

export default function Reglamento() {
  const [cfg, setCfg] = useState(null)
  const clubName = cfg?.nombre_club || 'Club BOA'
  const formato = cfg?.formato_partido || 'set9'
  useEffect(() => {
    supabase.from('v2_config').select('*').eq('id', 1).single()
      .then(({ data }) => { if (data) setCfg(data) })
  }, [])

  const rango = cfg?.max_puestos_desafio ?? 4
  const diasExp = cfg?.dias_expiracion_desafio ?? 7
  const ventana = horasTexto(cfg?.ventana_validacion_minutos ?? 1440)
  const horasWo = cfg?.horas_wo_cancelacion ?? 24

  const faqs = [
    { q: '¿A quién puedo desafiar?', a: `Hasta ${rango} puestos por encima tuyo, siempre que el rival no esté lesionado y ninguno de los dos tenga ya un desafío activo. Con la Wild Card puedes desafiar a cualquiera por encima, sin límite de rango.` },
    { q: '¿Qué pasa si no juego? (inactividad)', a: 'El reloj cuenta los días sin jugar desde tu último partido. A los 14 días bajas 2 puestos; a los 21, 1 más; a los 28, 1 más y quedas lesionado; y 1 más por cada 7 días extra. Tener un desafío activo (pendiente o aceptado) pausa el reloj.' },
    { q: '¿Qué es la Wild Card?', a: 'Cada jugador tiene 1 Wild Card al año (se resetea el 1 de enero) para desafiar a cualquier posición por encima sin límite de rango.' },
    { q: '¿Qué pasa si me cancelan tarde?', a: `Si tu rival cancela un desafío con cancha reservada a menos de ${horasWo} horas del partido, puedes marcarle un WO a tu favor.` },
    { q: '¿Cómo corrijo un resultado mal anotado?', a: `Apenas se registra un resultado el ranking se mueve al instante. Durante los siguientes ${ventana} cualquiera de los dos jugadores puede corregir el marcador (revierte y reaplica). Pasada esa ventana, o si ya fue validado, solo un administrador.` },
    { q: '¿Quién valida un resultado?', a: 'Lo valida el rival (no quien lo anotó). Validar lo deja definitivo. Si no estás de acuerdo, en vez de validar usa Corregir dentro de la ventana.' },
    { q: '¿Qué pasa si me lesiono?', a: 'Un jugador lesionado no puede ser desafiado. La lesión puede marcarla el propio jugador desde su perfil, o se activa automáticamente a los 28 días de inactividad. Mientras estés inactivo, el reloj sigue corriendo.' },
    { q: '¿Cómo vuelvo de una lesión?', a: 'Crear un desafío te reactiva automáticamente (te saca el estado de lesionado). También puedes darte de alta desde tu perfil.' },
    { q: '¿Cuándo se actualiza el ranking?', a: 'Al instante, apenas se registra cada resultado. Cada jueves además se genera una foto semanal del ranking con las flechas de la semana y un resumen compartible.' },
    { q: '¿Cuándo expira un desafío?', a: `A los ${diasExp} días de creado si no se juega. Al expirar, ambos quedan libres para nuevos desafíos.` },
    { q: '¿Qué formato de partido se juega?', a: `${FORMATOS[formato]?.label}. ${FORMATOS[formato]?.regla} El administrador puede cambiar el formato; aplica a los partidos nuevos.` },
  ]

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

      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <i className="ti ti-help-circle" style={{ color: '#1D9E75', fontSize: 18 }} aria-hidden="true" />
          <span style={{ fontSize: 14, fontWeight: 500 }}>Preguntas frecuentes</span>
        </div>
        {faqs.map((f, i) => (
          <details key={i} style={{ borderTop: '0.5px solid #eee', padding: '8px 0' }}>
            <summary style={{ fontSize: 13, fontWeight: 500, cursor: 'pointer', color: '#0F6E56', listStyle: 'none' }}>{f.q}</summary>
            <div style={{ fontSize: 13, color: '#555', marginTop: 6, lineHeight: 1.6 }}>{f.a}</div>
          </details>
        ))}
      </div>

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
