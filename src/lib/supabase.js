import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ─── Auth ────────────────────────────────────────────────────

export async function registerPlayer({ nombre, apellido, email, pin, telefono }) {
  const { data, error } = await supabase.rpc('register_player', {
    p_nombre: nombre,
    p_apellido: apellido,
    p_email: email,
    p_pin: pin,
    p_telefono: telefono,
  })
  if (error) throw error
  return data
}

export async function loginPlayer({ email, pin }) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('email', email)
    .single()
  if (error || !data) throw new Error('Email no encontrado')

  const { data: ok } = await supabase.rpc('verify_pin', {
    pin,
    hash: data.pin_hash,
  })
  if (!ok) throw new Error('PIN incorrecto')
  return data
}

// ─── Players ─────────────────────────────────────────────────

export async function getPlayers() {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('activo', true)
    .not('posicion', 'is', null)
    .order('posicion', { ascending: true })
  if (error) throw error
  return data
}

export async function getAllPlayers() {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .order('posicion', { ascending: true, nullsLast: true })
  if (error) throw error
  return data
}

export async function updatePlayer(id, updates) {
  const { data, error } = await supabase
    .from('players')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Challenges ──────────────────────────────────────────────

export async function getChallenges() {
  const { data, error } = await supabase
    .from('challenges')
    .select(`
      *,
      challenger:players!challenges_challenger_id_fkey(id, nombre, apellido, posicion),
      challenged:players!challenges_challenged_id_fkey(id, nombre, apellido, posicion)
    `)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export async function createChallenge({ challenger_id, challenged_id, deadline }) {
  const { data, error } = await supabase
    .from('challenges')
    .insert({ challenger_id, challenged_id, deadline, status: 'pending' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateChallenge(id, updates) {
  const { data, error } = await supabase
    .from('challenges')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Courts & Slots ──────────────────────────────────────────

export async function getCourts() {
  const { data, error } = await supabase.from('courts').select('*')
  if (error) throw error
  return data
}

export async function getSlots(day) {
  const { data, error } = await supabase
    .from('slots')
    .select('*, player:players(nombre, apellido)')
    .eq('dia', day)
  if (error) throw error
  return data
}

export async function reserveSlot({ court_id, dia, hora, reserved_by, challenge_id }) {
  const { data, error } = await supabase
    .from('slots')
    .upsert({
      court_id, dia, hora,
      reserved_by,
      challenge_id,
      status: 'reserved',
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function confirmSlotPayment(court_id, dia, hora) {
  const { data, error } = await supabase
    .from('slots')
    .update({ status: 'confirmed' })
    .eq('court_id', court_id)
    .eq('dia', dia)
    .eq('hora', hora)
    .select()
    .single()
  if (error) throw error
  return data
}

// ─── Weekly config ───────────────────────────────────────────

export async function getWeeklyConfig() {
  const { data, error } = await supabase
    .from('weekly_config')
    .select('*')
    .eq('id', 1)
    .single()
  if (error) throw error
  return data
}
