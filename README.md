# Escalerilla BOA

App de gestión de ranking de tenis con sistema de desafíos, reserva de canchas y bot de WhatsApp.

---

## Stack

- **Frontend**: React + Vite → deploy en Vercel
- **Base de datos + Auth**: Supabase (PostgreSQL)
- **Bot WhatsApp**: Twilio
- **Cron reset semanal**: pg_cron en Supabase

---

## Setup paso a paso

### 1. Clonar el repositorio

```bash
git clone https://github.com/TU_USUARIO/escalerilla-boa.git
cd escalerilla-boa
npm install
```

### 2. Supabase

1. Crear cuenta en https://supabase.com (usar login con GitHub)
2. Nuevo proyecto → nombre: `escalerilla-boa` → región: South America (São Paulo)
3. Ir a **SQL Editor** y ejecutar el contenido de `supabase/schema.sql`
4. Ir a **Settings → API** y copiar:
   - Project URL
   - anon public key

### 3. Twilio

1. Crear cuenta en https://twilio.com/try-twilio
2. Activar **WhatsApp Sandbox**: Console → Messaging → Try it out → Send a WhatsApp message
3. Ir a **Console Dashboard** y copiar:
   - Account SID
   - Auth Token
4. El número de sandbox es `whatsapp:+14155238886`
5. Cuando estés listo para producción: comprar número con WhatsApp habilitado (~$1.50 USD/mes) y solicitar aprobación Meta

### 4. Variables de entorno

```bash
cp .env.example .env.local
# Editar .env.local con tus credenciales reales
```

### 5. Correr en local

```bash
npm run dev
# Abre http://localhost:5173
```

### 6. Deploy en Vercel

1. Crear cuenta en https://vercel.com (usar login con GitHub)
2. New Project → importar repositorio `escalerilla-boa`
3. Settings → Environment Variables → agregar todas las variables de `.env.example` con tus valores reales
4. Deploy → la app queda en `https://escalerilla-boa.vercel.app`

### 7. Primer admin

En Supabase → Table Editor → players → editar el registro de tu cuenta:
- `activo` = true
- `es_admin` = true
- `posicion` = 1 (o la que corresponda)

---

## Flujo de juego

```
Ranking → Desafiar
         ↓
     Desafíos → Aceptar (48 h)
         ↓
  Coordinar día por WhatsApp
         ↓
     Canchas → Reservar horario
         ↓
  Admin valida pago
         ↓
   Resultados → Anotar score
         ↓
  Jueves 00:00 → Reset automático + ranking nuevo
```

---

## Bot WhatsApp — eventos automáticos

| Evento | Mensaje al grupo |
|--------|-----------------|
| Nuevo desafío | ⚔️ X desafió a Y |
| Desafío aceptado | ✅ Y aceptó el desafío |
| Desafío rechazado | ❌ Y rechazó el desafío |
| Cancha reservada | 🎾 Cancha X · día · hora |
| Pago confirmado | 💳 Pago confirmado |
| Resultado | 🏆 X 9 — Y 7 |
| Ranking semanal | 📊 Top 5 + link |
| Recordatorio | ⏰ Partidos pendientes |

---

## Estructura del proyecto

```
escalerilla-boa/
  api/
    notify.js          ← Serverless function Twilio (Vercel)
  src/
    pages/
      Auth.jsx         ← Login + registro con PIN
      Ranking.jsx      ← Tabla de posiciones
      Desafios.jsx     ← Flujo de desafíos
      Canchas.jsx      ← Reserva de horarios
      Resultados.jsx   ← Anotar y ver partidos
      Admin.jsx        ← Panel administrador
    components/
      Layout.jsx       ← Navbar + contenedor
      SessionContext.jsx ← Estado global del jugador
    lib/
      supabase.js      ← Cliente + helpers de BD
      notify.js        ← Helpers para mensajes WA
    index.css          ← Estilos globales
    main.jsx           ← Entry point + router
  supabase/
    schema.sql         ← Tablas + RLS + cron job
  .env.example         ← Variables de entorno requeridas
  package.json
  vite.config.js
  index.html
```

---

## Costo mensual estimado (32+ jugadores)

| Servicio | Costo |
|----------|-------|
| GitHub | Gratis |
| Vercel | Gratis |
| Supabase | Gratis |
| Twilio número | ~$1.50 USD |
| Twilio mensajes WA | ~$3–6 USD |
| **Total** | **~$5–8 USD** |
