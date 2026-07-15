// Genera los íconos de la app (pelota de tenis sobre fondo verde cancha) desde
// un único SVG, con sharp. Reproducible: `node scripts/gen-icons.mjs`.
// Sobrescribe los mismos nombres en public/icons/.
import sharp from 'sharp'
import { mkdirSync } from 'fs'

// SVG aprobado (viewBox 96x96; canvas cuadrado, el SO redondea). width/height se
// fijan por tamaño para que sharp renderice a resolución nativa (nítido, sin upscale).
const svg = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
  <rect width="96" height="96" fill="#1B5E20"/>
  <circle cx="48" cy="48" r="34" fill="#9DBF3B"/>
  <path d="M24.3 27.5 C 39 39, 39 57, 24.3 68.5" fill="none" stroke="#F5F5EE" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M71.7 27.5 C 57 39, 57 57, 71.7 68.5" fill="none" stroke="#F5F5EE" stroke-width="5.5" stroke-linecap="round"/>
</svg>`

// Mismos nombres que hoy: existentes + los del manifest.
const targets = [
  ['public/icons/favicon-32.png', 32],
  ['public/icons/apple-touch-icon.png', 180],
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
]

mkdirSync('public/icons', { recursive: true })
for (const [path, size] of targets) {
  await sharp(Buffer.from(svg(size))).png().toFile(path)
  console.log('✓', path, `(${size}x${size})`)
}
console.log('Íconos generados.')
