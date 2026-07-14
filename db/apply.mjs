import { readFileSync, existsSync } from 'fs'
import { Client } from 'pg'

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const url = process.env.DATABASE_URL
if (!url) { console.error('Falta DATABASE_URL en .env'); process.exit(1) }

const files = process.argv.slice(2).sort()
if (files.length === 0) { console.error('Indica al menos un archivo .sql'); process.exit(1) }

const host = new URL(url).hostname
console.log('Conectando a: ' + host)
if (url.includes('rnaqvfmuslddeecgscox')) {
  console.error('DATABASE_URL apunta a PRODUCCION. Abortando por seguridad.')
  process.exit(1)
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })

try {
  await client.connect()
  for (const f of files) {
    const sql = readFileSync(f, 'utf8')
    process.stdout.write('Aplicando ' + f + ' ... ')
    await client.query(sql)
    console.log('OK')
  }
  console.log('Listo')
} catch (err) {
  console.error('Error: ' + err.message)
  process.exitCode = 1
} finally {
  await client.end()
}
