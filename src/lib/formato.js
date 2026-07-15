import { supabase } from './supabase'

// Metadatos de los 3 formatos de partido (la ley vive en la función SQL validar_marcador)
export const FORMATOS = {
  set9:     { label: '1 set a 9',                      regla: 'Un set a 9 games: gana el primero en llegar a 9 (9-N con N≤7, o 9-8 vía tiebreak al empatar 8-8).' },
  set6:     { label: '1 set a 6',                      regla: 'Un set a 6 games: 6-N con N≤4, 7-5, o 7-6 vía tiebreak al empatar 6-6.' },
  dos_sets: { label: '2 sets a 6 + super tiebreak',    regla: '2 sets a 6 (cada set: 6-N N≤4, 7-5, o 7-6 con tiebreak). Si va 1-1 se define con un super tiebreak a 7 con diferencia de 2 (7-5 sí, 7-6 no; sigue 8-6, 9-7…), que se guarda como tercer set.' },
}

// ¿Cuántos pares de inputs mostrar según formato + valores actuales?
export function setsVisibles(formato, sets) {
  if (formato !== 'dos_sets') return 1
  const w = (s) => {
    const a = parseInt(s?.a), b = parseInt(s?.b)
    if (isNaN(a) || isNaN(b) || a === b) return null
    return a > b ? 'a' : 'b'
  }
  const w0 = w(sets?.[0]), w1 = w(sets?.[1])
  return (w0 && w1 && w0 !== w1) ? 3 : 2  // el 3ro (super TB) solo si van 1-1
}

// sets del formato para enviar (recorta a los visibles, castea a int)
export function setsPayload(formato, sets) {
  const n = setsVisibles(formato, sets)
  return sets.slice(0, n).map(s => ({ a: parseInt(s.a), b: parseInt(s.b) }))
}

// Valida vía la RPC (la función SQL es la ley). Devuelve {ok, ganador, score_a, score_b, error}
export async function validarMarcador(formato, sets) {
  const { data, error } = await supabase.rpc('validar_marcador', { p_formato: formato, p_sets: setsPayload(formato, sets) })
  if (error) return { ok: false, error: error.message }
  return data
}

// Texto de un partido a partir de sus sets (o score_a/score_b si no hay sets)
export function marcadorTexto(c) {
  if (Array.isArray(c?.sets) && c.sets.length) return c.sets.map(s => `${s.a}-${s.b}`).join('  ')
  return `${c.score_a}–${c.score_b}`
}
