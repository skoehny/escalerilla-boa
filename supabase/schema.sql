-- ============================================================
-- ESCALERILLA BOA — Schema completo
-- Ejecutar en Supabase → SQL Editor
-- ============================================================

-- Extensión para cron jobs
create extension if not exists pg_cron;

-- ============================================================
-- TABLAS
-- ============================================================

create table players (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  apellido    text not null,
  email       text unique not null,
  pin_hash    text not null,
  telefono    text not null,
  posicion    int,
  posicion_anterior int,
  victorias   int default 0,
  derrotas    int default 0,
  rechazos_mes int default 0,
  lesionado   boolean default false,
  lesion_nota text default '',
  activo      boolean default false,
  es_admin    boolean default false,
  created_at  timestamptz default now()
);

create table challenges (
  id            uuid primary key default gen_random_uuid(),
  challenger_id uuid references players(id) not null,
  challenged_id uuid references players(id) not null,
  status        text default 'pending',
  -- pending | accepted | expired | completed
  deadline      date,
  slot_day      text,
  slot_court    text,
  slot_hour     text,
  pago_confirmado boolean default false,
  score_a       int,
  score_b       int,
  ganador       text,
  -- 'challenger' | 'challenged'
  created_at    timestamptz default now()
);

create table courts (
  id       text primary key,
  nombre   text not null,
  surface  text not null
  -- 'arcilla' | 'dura'
);

create table slots (
  id         uuid primary key default gen_random_uuid(),
  court_id   text references courts(id) not null,
  dia        text not null,
  hora       text not null,
  status     text default 'free',
  -- free | reserved | pending_pay | confirmed
  reserved_by uuid references players(id),
  challenge_id uuid references challenges(id),
  created_at timestamptz default now(),
  unique(court_id, dia, hora)
);

create table weekly_config (
  id           int primary key default 1,
  semana       int default 1,
  fecha_inicio date,
  fecha_cierre date,
  -- miercoles
  fecha_ranking date
  -- jueves
);

-- ============================================================
-- DATOS INICIALES
-- ============================================================

insert into courts (id, nombre, surface) values
  ('c1', 'Cancha 1', 'arcilla'),
  ('c2', 'Cancha 2', 'arcilla'),
  ('c3', 'Cancha 3', 'dura');

insert into weekly_config (id, semana, fecha_inicio, fecha_cierre, fecha_ranking)
values (1, 1, current_date, current_date + 3, current_date + 4);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table players   enable row level security;
alter table challenges enable row level security;
alter table courts    enable row level security;
alter table slots     enable row level security;

-- Todos pueden leer jugadores activos
create policy "players_read" on players
  for select using (activo = true);

-- Solo el propio jugador puede actualizar su perfil
create policy "players_update_own" on players
  for update using (id::text = current_setting('request.jwt.claims', true)::json->>'sub');

-- Cualquier autenticado puede insertar (registro)
create policy "players_insert" on players
  for insert with check (true);

-- Desafíos: cualquier jugador autenticado puede leer y crear
create policy "challenges_read" on challenges
  for select using (true);

create policy "challenges_insert" on challenges
  for insert with check (true);

create policy "challenges_update" on challenges
  for update using (true);

-- Canchas: lectura pública
create policy "courts_read" on courts
  for select using (true);

-- Slots: lectura pública, escritura autenticada
create policy "slots_read" on slots
  for select using (true);

create policy "slots_write" on slots
  for all using (true);

-- ============================================================
-- FUNCIÓN: reset semanal (corre cada jueves a medianoche)
-- ============================================================

create or replace function weekly_reset()
returns void language plpgsql as $$
begin
  -- 1. Caducar desafíos que no consiguieron cancha
  update challenges
  set status = 'expired'
  where status = 'accepted'
    and slot_day is null
    and deadline < current_date;

  -- 2. Caducar desafíos con cancha pero sin pago confirmado
  update challenges
  set status = 'expired'
  where status = 'accepted'
    and pago_confirmado = false
    and deadline < current_date;

  -- 3. Penalizar jugadores inactivos (sin partido en 2 semanas)
  -- (lógica: si no tiene desafío completado en los últimos 14 días, baja 2)
  update players p
  set posicion_anterior = posicion,
      posicion = posicion + 2
  where activo = true
    and lesionado = false
    and not exists (
      select 1 from challenges c
      where (c.challenger_id = p.id or c.challenged_id = p.id)
        and c.status = 'completed'
        and c.created_at > now() - interval '14 days'
    );

  -- 4. Resetear contadores mensuales (solo el primer jueves del mes)
  update players
  set rechazos_mes = 0
  where extract(day from current_date) <= 7;

  -- 5. Limpiar slots de semanas pasadas
  delete from slots
  where created_at < now() - interval '7 days';

  -- 6. Actualizar semana en config
  update weekly_config
  set semana = semana + 1,
      fecha_inicio = current_date,
      fecha_cierre = current_date + 3,
      fecha_ranking = current_date + 4;
end;
$$;

-- ============================================================
-- CRON JOB — jueves a medianoche hora Chile (UTC-3 = 03:00 UTC)
-- ============================================================

select cron.schedule(
  'weekly-reset',
  '0 3 * * 4',
  'select weekly_reset()'
);

-- ============================================================
-- FUNCIÓN: hash simple de PIN (usa pgcrypto)
-- ============================================================

create extension if not exists pgcrypto;

create or replace function hash_pin(pin text)
returns text language sql as $$
  select crypt(pin, gen_salt('bf'));
$$;

create or replace function verify_pin(pin text, hash text)
returns boolean language sql as $$
  select hash = crypt(pin, hash);
$$;
