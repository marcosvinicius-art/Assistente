// Conexão com o Postgres da Vercel (integração "Storage" no dashboard, que define
// a variável de conexão sozinha) e criação das tabelas na primeira chamada.
//
// Três tabelas:
//   users    — conta de cada cliente (email + senha com hash, nunca em texto puro)
//   records  — todo lançamento/meta/investimento de todo cliente, cada linha marcada
//              com o dono (user_id) e o tipo (kind); o conteúdo variável vai num JSONB,
//              pra não precisar de uma tabela por tipo de dado.
//   feedback — nota (1-5) e comentário opcional, de clientes E do admin, visível
//              só no painel do admin. Guarda o email direto (não um user_id com
//              referência à tabela "users") porque o admin não tem linha lá — é
//              uma conta fixa por variável de ambiente, não um cliente cadastrado.
const { Pool } = require("pg");

// O nome da variável muda conforme o banco que a Vercel oferece no momento
// (Postgres próprio, Neon, Supabase). Aceitar todos evita o site cair inteiro só
// porque a integração escolheu outro nome que não "POSTGRES_URL".
const VARIAVEIS_DE_CONEXAO = [
  "POSTGRES_URL",
  "DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
];

function stringDeConexao() {
  for (var i = 0; i < VARIAVEIS_DE_CONEXAO.length; i++) {
    if (process.env[VARIAVEIS_DE_CONEXAO[i]]) return process.env[VARIAVEIS_DE_CONEXAO[i]];
  }
  return null;
}

function erroDeConfiguracao() {
  var e = new Error(
    "O banco de dados não está ligado ao projeto na Vercel. Abra Storage, crie ou " +
    "conecte um Postgres a este projeto e reimplante (Deployments > Redeploy)."
  );
  // Marca pra rota saber que repetir a ação não adianta: falta configuração.
  e.configMissing = true;
  return e;
}

// A conexão nasce na primeira consulta, não na importação do arquivo. Criando no
// topo, um banco ausente derrubava com 500 até as rotas que nem usam banco — como
// "estou logado?", que sem cookie deveria só responder "não".
function pool() {
  if (!global.__pgPool) {
    var url = stringDeConexao();
    if (!url) throw erroDeConfiguracao();
    global.__pgPool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });
  }
  return global.__pgPool;
}

// IF NOT EXISTS torna isso seguro de rodar em toda invocação "fria" da function —
// sem precisar de um passo de migração separado que o cliente teria que executar.
function ensureSchema() {
  if (!global.__schemaReady) {
    global.__schemaReady = pool().query(`
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
      CREATE TABLE IF NOT EXISTS feedback (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).catch(function (e) {
      // Um erro guardado na promise se repetiria pra sempre, mesmo depois do banco
      // voltar: a próxima chamada precisa poder tentar de novo.
      global.__schemaReady = null;
      throw e;
    });
  }
  return global.__schemaReady;
}

async function query(text, params) {
  await ensureSchema();
  return pool().query(text, params);
}

// Erro de configuração precisa chegar até a tela. Escondido atrás de um "tenta de
// novo", faz a pessoa tentar pra sempre — e tentar não conserta configuração.
function mensagemDeFalha(e, padrao) {
  return (e && e.configMissing) ? e.message : padrao;
}

module.exports = { query, mensagemDeFalha, stringDeConexao };
