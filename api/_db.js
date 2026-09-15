// Conexão com o Postgres da Vercel (integração "Storage" > "Postgres" no dashboard,
// que define POSTGRES_URL sozinha) e criação das tabelas na primeira chamada.
//
// Duas tabelas apenas:
//   users   — conta de cada cliente (email + senha com hash, nunca em texto puro)
//   records — todo lançamento/meta/investimento de todo cliente, cada linha marcada
//             com o dono (user_id) e o tipo (kind); o conteúdo variável vai num JSONB,
//             pra não precisar de uma tabela por tipo de dado.
const { Pool } = require("pg");

if (!global.__pgPool) {
  if (!process.env.POSTGRES_URL) {
    throw new Error(
      "POSTGRES_URL não configurada. No dashboard da Vercel: Storage > Create Database > Postgres, " +
      "conecte ao projeto — a variável é criada sozinha."
    );
  }
  global.__pgPool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
}
const pool = global.__pgPool;

var schemaReady = global.__schemaReady || null;

// IF NOT EXISTS torna isso seguro de rodar em toda invocação "fria" da function —
// sem precisar de um passo de migração separado que o cliente teria que executar.
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS records (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('transaction','goal','investment')),
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS records_user_kind_idx ON records(user_id, kind);
    `);
    global.__schemaReady = schemaReady;
  }
  return schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return pool.query(text, params);
}

module.exports = { query };
