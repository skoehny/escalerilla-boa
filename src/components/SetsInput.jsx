import { setsVisibles } from '../lib/formato'

// Inputs de marcador adaptados al formato: 1 par (set9/set6) o 2-3 pares (dos_sets;
// el 3ro —super tiebreak— aparece solo si los 2 primeros van 1-1). `sets` es un
// array de al menos 3 objetos {a,b} (strings); se usan los `setsVisibles`.
export default function SetsInput({ formato, sets, setSets, nameA, nameB }) {
  const nVis = setsVisibles(formato, sets)
  const setVal = (i, side, val) => setSets(sets.map((s, j) => j === i ? { ...s, [side]: val } : s))
  const rowLabel = (i) => {
    if (formato === 'dos_sets') return i === 2 ? 'Super TB' : `Set ${i + 1}`
    return 'Games'
  }
  const rows = []
  for (let i = 0; i < nVis; i++) {
    rows.push(
      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: '#888', width: 52, flexShrink: 0, paddingBottom: 9 }}>{rowLabel(i)}</span>
        <div style={{ flex: 1 }}>
          {i === 0 && <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{nameA}</label>}
          <input type="number" min="0" placeholder="0" value={sets[i]?.a ?? ''} onChange={e => setVal(i, 'a', e.target.value)} />
        </div>
        <span style={{ fontSize: 16, color: '#888', paddingBottom: 8 }}>–</span>
        <div style={{ flex: 1 }}>
          {i === 0 && <label style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 3 }}>{nameB}</label>}
          <input type="number" min="0" placeholder="0" value={sets[i]?.b ?? ''} onChange={e => setVal(i, 'b', e.target.value)} />
        </div>
      </div>
    )
  }
  return <div>{rows}</div>
}

// Estado inicial de sets (3 pares vacíos)
export const emptySets = () => [{ a: '', b: '' }, { a: '', b: '' }, { a: '', b: '' }]

// Sets existentes -> estado editable (rellena a 3)
export function setsFromChallenge(c) {
  const base = Array.isArray(c?.sets) && c.sets.length
    ? c.sets.map(s => ({ a: String(s.a), b: String(s.b) }))
    : [{ a: c?.score_a != null ? String(c.score_a) : '', b: c?.score_b != null ? String(c.score_b) : '' }]
  while (base.length < 3) base.push({ a: '', b: '' })
  return base
}
