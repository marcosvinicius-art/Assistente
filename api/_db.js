// Conexão com o Postgres da Vercel (integração "Storage" no dashboard, que define
// a variável de conexão sozinha) e criação das tabelas na primeira chamada.
//
// Quatro tabelas (a quarta, config, guarda as chaves do painel do admin):
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
      -- A lista de tipos válidos vive em KIND_BY_RESOURCE, na API, que recusa
      -- qualquer recurso fora dela. Mantê-la também aqui obrigava uma migração de
      -- banco a cada tipo novo — foi o que aconteceu ao acrescentar "card" —, e
      -- o CREATE TABLE acima não altera tabela que já existe. Por isso a trava
      -- fica num lugar só. DROP IF EXISTS torna isto seguro de repetir.
      ALTER TABLE records DROP CONSTRAINT IF EXISTS records_kind_check;
      -- Freio de força bruta. Sem isto, nada impede um script de testar senhas
      -- sem limite: o login respondia na mesma velocidade para sempre.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS falhas INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS travado_ate TIMESTAMPTZ;
      -- Conta nova nasce aguardando aprovação. O DEFAULT é true de propósito:
      -- ele vale para as linhas que já existiam, que não podem ser trancadas
      -- fora do app de uma hora pra outra. Quem decide o contrário é o cadastro,
      -- que grava false explicitamente.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS aprovado BOOLEAN NOT NULL DEFAULT true;
      -- Aviso que o admin manda só para este cliente (uma cobrança, por
      -- exemplo): { texto, tipo }. Some junto com a conta.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS aviso JSONB;
      -- Cobrança aberta para o cliente: { valorCentavos, vencimento, mensagem,
      -- pix, link, criadaEm, pagoInformadoEm }. Uma por vez; some quando o
      -- admin confirma o pagamento ou cancela.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS cobranca JSONB;
      -- Manutenção só deste cliente: fica fora do app enquanto os demais usam.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS manutencao BOOLEAN NOT NULL DEFAULT false;
      -- Agente do WhatsApp: o número ligado à conta (wa_id da Meta, só dígitos),
      -- o código de conexão de uso único, o comprovante que aguarda o valor e os
      -- ids do último lançamento feito por lá (para o "desfazer").
      ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_codigo TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_codigo_ate TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_pendente JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_ultimos JSONB;
      -- Assinatura. "cortesia" nasce true para as contas que já existiam (o
      -- DEFAULT vale para elas): ninguém que já usava o app é bloqueado de
      -- surpresa. Cadastro novo grava false e ganha teste_ate.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS cortesia BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS teste_ate TIMESTAMPTZ;
      -- { status, plano, metodo, mpId, ate, pixPendente } — "ate" é até quando
      -- está pago; é ele que decide o acesso, não o status.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS assinatura JSONB;
      -- Redefinir senha por e-mail: só o hash do token (quem lê o banco não
      -- consegue usar o link), validade curta e uso único.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_hash TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_ate TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_pedido_em TIMESTAMPTZ;
      -- Lembrete "seu teste acaba amanhã": uma vez por conta.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS lembrete_teste_em TIMESTAMPTZ;
      -- Pagamentos do Mercado Pago já processados: o mesmo aviso chegando duas
      -- vezes não estende o acesso duas vezes.
      CREATE TABLE IF NOT EXISTS pagamentos_mp (
        id TEXT PRIMARY KEY,
        user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_whatsapp_idx ON users(whatsapp) WHERE whatsapp IS NOT NULL;
      -- A Meta reenvia o aviso quando a resposta demora; o id da mensagem
      -- gravado aqui impede lançar o mesmo gasto duas vezes.
      CREATE TABLE IF NOT EXISTS wa_mensagens (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Chaves que o admin liga e desliga pelo painel (aviso, cadastros,
      -- manutenção, assistente). Uma linha só, chave "site": são poucos campos,
      -- sempre lidos juntos.
      -- Reportes que os clientes abrem pelo botão "Reportar" (erro, melhoria,
      -- ideia), com print opcional. Só o admin lê. Guarda o email direto pelo
      -- mesmo motivo do feedback: o admin não tem linha própria em users.
      CREATE TABLE IF NOT EXISTS reportes (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        tipo TEXT NOT NULL,
        texto TEXT NOT NULL,
        imagem TEXT,
        local TEXT,
        navegador TEXT,
        status TEXT NOT NULL DEFAULT 'aberto',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS config (
        chave TEXT PRIMARY KEY,
        valor JSONB NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
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

// Sem linha gravada vale o padrão: o site como sempre funcionou. Campos novos
// entram aqui e passam a valer até para quem já tinha salvo uma configuração.
var CONFIG_PADRAO = {
  aviso: null, // { texto, tipo: "info" | "alerta" | "urgente" }
  cadastrosAbertos: true,
  manutencao: false,
  assistente: true,
  // Assinatura: preços em reais e dias de teste grátis. Editáveis no painel.
  precoMensal: 19.9,
  precoAnual: 199,
  diasTeste: 7,
  // Conta nova precisa ser liberada pelo admin? (era o único jeito antes.)
  aprovarCadastros: true,
};

async function lerConfig() {
  var r = await query("SELECT valor FROM config WHERE chave = 'site'");
  return Object.assign({}, CONFIG_PADRAO, r.rows.length ? r.rows[0].valor : {});
}

async function gravarConfig(mudancas) {
  var nova = Object.assign(await lerConfig(), mudancas);
  await query(
    "INSERT INTO config (chave, valor, atualizado_em) VALUES ('site', $1, now()) " +
    "ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()",
    [nova]
  );
  return nova;
}

// Cliente fora do app: manutenção geral ligada ou manutenção só dele. Uma
// consulta só, para não somar duas idas ao banco em cada leitura de dados.
async function clienteEmManutencao(userId) {
  var r = await query(
    "SELECT COALESCE((SELECT (valor->>'manutencao')::boolean FROM config WHERE chave = 'site'), false) AS geral, " +
    "COALESCE((SELECT manutencao FROM users WHERE id = $1), false) AS dele",
    [userId]
  );
  return r.rows[0].geral || r.rows[0].dele;
}

// Situação de acesso de uma conta (linha de users com cortesia, teste_ate,
// assinatura). Ler o app nunca é bloqueado; "liberado" decide se pode gravar.
function situacaoAssinatura(u) {
  var agora = Date.now();
  var a = u.assinatura || null;
  var ate = a && a.ate ? new Date(a.ate).getTime() : 0;
  var teste = u.teste_ate ? new Date(u.teste_ate).getTime() : 0;
  var motivo = u.cortesia ? "cortesia" : ate > agora ? "assinatura" : teste > agora ? "teste" : "bloqueado";
  return {
    liberado: motivo !== "bloqueado",
    motivo: motivo,
    testeAte: u.teste_ate || null,
    diasTeste: teste > agora ? Math.ceil((teste - agora) / 86400000) : 0,
    status: a ? a.status : null,
    plano: a ? a.plano : null,
    metodo: a ? a.metodo : null,
    ate: a && a.ate ? a.ate : null,
  };
}

async function situacaoDoUsuario(userId) {
  var r = await query("SELECT cortesia, teste_ate, assinatura FROM users WHERE id = $1", [userId]);
  return r.rows.length ? situacaoAssinatura(r.rows[0]) : { liberado: false, motivo: "bloqueado" };
}

module.exports = {
  query, mensagemDeFalha, stringDeConexao, lerConfig, gravarConfig, clienteEmManutencao,
  situacaoAssinatura, situacaoDoUsuario,
};
