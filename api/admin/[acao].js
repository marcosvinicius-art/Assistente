const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");
const wa = require("../_whatsapp");
const agente = require("../_agente");

// As rotas de administração num arquivo só. O plano gratuito da Vercel
// permite 12 funções por implantação, e cada arquivo aqui dentro contava como
// uma: a sexta rota fazia o build inteiro falhar, sem subir nada.
//
// Rota dinâmica mantém os endereços idênticos (/api/admin/clients continua
// /api/admin/clients), então nada no front-end precisou mudar. A checagem de
// admin acontece uma vez, antes de qualquer ação.
var ALFABETO = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function senhaTemporaria() {
  // Alfabeto sem 0/O/1/l/I: a senha vai ser ditada ou digitada à mão, e esses
  // pares são lidos errado com frequência.
  var bytes = crypto.randomBytes(12);
  var fora = "";
  for (var i = 0; i < bytes.length; i++) fora += ALFABETO[bytes[i] % ALFABETO.length];
  return fora;
}

async function listarClientes(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  // Pendentes primeiro: são as únicas linhas que pedem uma decisão, e no fim de
  // uma lista longa ficariam sem ser vistas.
  var r = await db.query("SELECT email, created_at, aprovado, aviso, cobranca, manutencao, (whatsapp IS NOT NULL) AS tem_whatsapp FROM users ORDER BY aprovado ASC, created_at DESC");
  return res.status(200).json(r.rows.map(function (u) {
    return {
      email: u.email, criadoEm: u.created_at, aprovado: u.aprovado,
      aviso: u.aviso || null, cobranca: u.cobranca || null, manutencao: !!u.manutencao, whatsapp: !!u.tem_whatsapp,
    };
  }));
}

async function listarFeedback(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  var r = await db.query("SELECT email, rating, comment, created_at FROM feedback ORDER BY created_at DESC");
  return res.status(200).json(r.rows.map(function (f) {
    return { email: f.email, rating: f.rating, comment: f.comment, criadoEm: f.created_at };
  }));
}

async function aprovar(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var aprovado = body.aprovado !== false;
  if (!email) return res.status(400).json({ error: "missing_email" });

  // O admin não se suspende: a sessão dele vem da variável de ambiente e
  // continuaria valendo, então o botão prometeria um efeito que não existe.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({ error: "admin_sempre_liberado", message: "A conta de admin não depende de aprovação." });
  }

  var r = await db.query("UPDATE users SET aprovado = $1 WHERE email = $2 RETURNING id", [aprovado, email]);
  if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  return res.status(200).json({ email: email, aprovado: aprovado });
}

async function redefinirSenha(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  // A senha do admin é variável de ambiente, e a linha dele no banco tem hash
  // que não casa com nada: redefinir aqui não teria efeito e pareceria ter.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({
      error: "admin_nao_redefinivel",
      message: "A senha do admin fica nas variáveis de ambiente da Vercel, não aqui.",
    });
  }

  var nova = senhaTemporaria();
  var r = await db.query(
    "UPDATE users SET password_hash = $1, falhas = 0, travado_ate = NULL WHERE email = $2 RETURNING id",
    [auth.hashPassword(nova), email]
  );
  if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  return res.status(200).json({ senha: nova });
}

async function excluirCliente(req, res) {
  if (req.method !== "DELETE") return res.status(405).json({ error: "method_not_allowed" });
  var email = String(req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  // O admin não se apaga: a conta dele guarda os próprios dados, e o login
  // seguinte a recriaria vazia — parecendo perda de tudo sem motivo.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({ error: "admin_nao_excluivel", message: "A conta de admin não pode ser excluída por aqui." });
  }

  var alvo = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (!alvo.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  var userId = alvo.rows[0].id;

  var contagem = await db.query(
    "SELECT kind, COUNT(*)::int AS total FROM records WHERE user_id = $1 GROUP BY kind",
    [userId]
  );
  var porTipo = {};
  contagem.rows.forEach(function (c) { porTipo[c.kind] = c.total; });

  // A avaliação é anonimizada, não apagada: o email sai (é o dado pessoal), o
  // conteúdo fica. Apagar junto destruiria a opinião sobre o produto, que não
  // identifica mais ninguém depois que o email some.
  var anon = await db.query(
    "UPDATE feedback SET email = 'conta excluída' WHERE email = $1 OR email = $2",
    [email, email + " (sem conta)"]
  );

  // records some por ON DELETE CASCADE — sem risco de sobrar registro órfão.
  await db.query("DELETE FROM users WHERE id = $1", [userId]);

  return res.status(200).json({
    email: email,
    lancamentos: porTipo.transaction || 0,
    metas: porTipo.goal || 0,
    investimentos: porTipo.investment || 0,
    cartoes: porTipo.card || 0,
    avaliacoesAnonimizadas: anon.rowCount || 0,
  });
}

// Só contagens: o painel diz quanto o site é usado, nunca o que cada cliente
// lançou. A conta do admin fica fora de tudo — ela não é cliente.
async function numeros(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  var admin = String(process.env.ADMIN_EMAIL || "").toLowerCase();

  var r = await Promise.all([
    db.query(
      "SELECT COUNT(*)::int AS total, " +
      "COUNT(*) FILTER (WHERE aprovado = false)::int AS pendentes, " +
      "COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS novos30 " +
      "FROM users WHERE lower(email) <> $1",
      [admin]
    ),
    // "Ativo" = criou algum registro nos últimos 30 dias. Login não deixa
    // rastro no banco, então lançar é o único sinal de uso que existe.
    db.query(
      "SELECT COUNT(DISTINCT r.user_id)::int AS ativos FROM records r JOIN users u ON u.id = r.user_id " +
      "WHERE r.created_at > now() - interval '30 days' AND lower(u.email) <> $1",
      [admin]
    ),
    db.query(
      "SELECT r.kind, COUNT(*)::int AS total FROM records r JOIN users u ON u.id = r.user_id " +
      "WHERE lower(u.email) <> $1 GROUP BY r.kind",
      [admin]
    ),
    db.query(
      "SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes, COUNT(*)::int AS total " +
      "FROM users WHERE lower(email) <> $1 AND created_at >= date_trunc('month', now()) - interval '5 months' " +
      "GROUP BY 1 ORDER BY 1",
      [admin]
    ),
    db.query("SELECT COUNT(*)::int AS total, AVG(rating)::float AS media FROM feedback"),
  ]);

  var porTipo = {};
  r[2].rows.forEach(function (c) { porTipo[c.kind] = c.total; });
  return res.status(200).json({
    clientes: r[0].rows[0].total,
    pendentes: r[0].rows[0].pendentes,
    novos30: r[0].rows[0].novos30,
    ativos30: r[1].rows[0].ativos,
    lancamentos: porTipo.transaction || 0,
    metas: porTipo.goal || 0,
    investimentos: porTipo.investment || 0,
    cartoes: porTipo.card || 0,
    cadastrosPorMes: r[3].rows,
    avaliacoes: r[4].rows[0].total,
    notaMedia: r[4].rows[0].media,
  });
}

// Aceita só os campos conhecidos, cada um no formato certo: o corpo vem do
// navegador e não pode gravar no banco nada além do que o painel oferece.
async function salvarConfig(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var mudancas = {};

  ["cadastrosAbertos", "manutencao", "assistente"].forEach(function (k) {
    if (typeof body[k] === "boolean") mudancas[k] = body[k];
  });
  if ("aviso" in body) mudancas.aviso = normalizarAviso(body.aviso);
  if (!Object.keys(mudancas).length) return res.status(400).json({ error: "nada_para_salvar" });

  return res.status(200).json(await db.gravarConfig(mudancas));
}

// Texto vazio (ou aviso null) significa "tirar o aviso".
function normalizarAviso(a) {
  var texto = a && String(a.texto || "").trim().slice(0, 300);
  if (!texto) return null;
  return { texto: texto, tipo: ["alerta", "urgente"].indexOf(a.tipo) >= 0 ? a.tipo : "info" };
}

// Aviso para um cliente só. Fica na linha dele em "users", e o /api/config o
// entrega apenas à sessão dessa conta — nenhum outro cliente chega a recebê-lo.
async function avisoCliente(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  var aviso = normalizarAviso(body.aviso);
  var r = await db.query("UPDATE users SET aviso = $1 WHERE email = $2 RETURNING id, whatsapp", [aviso, email]);
  if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  var envio = aviso ? await avisarNoWhatsapp(r.rows[0].whatsapp, "📢 *Aviso do Wonner Sols*\n\n" + aviso.texto,
    process.env.WHATSAPP_TEMPLATE_AVISO, [aviso.texto]) : null;
  return res.status(200).json({ email: email, aviso: aviso, whatsapp: envio });
}

// Manda também no WhatsApp do cliente, se ele conectou o dele. Falhar aqui não
// desfaz o aviso/cobrança — o app continua mostrando —, só volta o motivo para
// o painel dizer ao admin.
async function avisarNoWhatsapp(numero, texto, modelo, parametros) {
  if (!numero) return "cliente sem WhatsApp conectado";
  if (!wa.configurado()) return "agente do WhatsApp não configurado";
  try {
    await wa.enviarParaCliente(numero, texto, modelo, parametros);
    return "enviado no WhatsApp";
  } catch (e) {
    // 131047: passou de 24h desde a última mensagem do cliente; sem modelo
    // aprovado a Meta não entrega mensagem puxada pela empresa.
    if (e && e.codigo === 131047) return "não enviado no WhatsApp: cliente fora da janela de 24h (configure o modelo aprovado)";
    return "não enviado no WhatsApp: " + ((e && e.message) || "erro");
  }
}

// Cobrança para um cliente. cobranca null = tirar (pagamento confirmado ou
// cancelado). O link vira botão na tela do cliente, então só https: aceitar
// qualquer texto deixaria passar "javascript:", que roda código no app dele.
async function cobranca(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  var nova = null;
  if (body.cobranca) {
    var c = body.cobranca;
    var centavos = Math.round(Number(c.valorCentavos));
    if (!Number.isFinite(centavos) || centavos <= 0 || centavos > 100000000) {
      return res.status(400).json({ error: "valor_invalido", message: "Informe um valor maior que zero." });
    }
    var vencimento = String(c.vencimento || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento) || isNaN(new Date(vencimento + "T12:00:00Z"))) {
      return res.status(400).json({ error: "vencimento_invalido", message: "Informe a data de vencimento." });
    }
    var link = String(c.link || "").trim().slice(0, 500);
    if (link && !/^https:\/\/[^\s]+$/i.test(link)) {
      return res.status(400).json({ error: "link_invalido", message: "O link de pagamento precisa começar com https://" });
    }
    nova = {
      valorCentavos: centavos,
      vencimento: vencimento,
      mensagem: String(c.mensagem || "").trim().slice(0, 300) || null,
      pix: String(c.pix || "").trim().slice(0, 140) || null,
      link: link || null,
      criadaEm: new Date().toISOString(),
      pagoInformadoEm: null,
    };
  }

  var r = await db.query("UPDATE users SET cobranca = $1 WHERE email = $2 RETURNING id, whatsapp", [nova, email]);
  if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  var envio = null;
  if (nova) {
    var valor = agente.brl(nova.valorCentavos / 100);
    var venc = nova.vencimento.split("-").reverse().join("/");
    var texto = "💳 *Cobrança do Wonner Sols*\n\nValor: *" + valor + "*\nVencimento: " + venc +
      (nova.mensagem ? "\n\n" + nova.mensagem : "") +
      (nova.pix ? "\n\nChave Pix: " + nova.pix : "") +
      (nova.link ? "\nPagar: " + nova.link : "") +
      "\n\nDepois de pagar, toque em *Já paguei* no app.";
    envio = await avisarNoWhatsapp(r.rows[0].whatsapp, texto, process.env.WHATSAPP_TEMPLATE_COBRANCA, [valor, venc]);
  }
  return res.status(200).json({ email: email, cobranca: nova, whatsapp: envio });
}

// Reportes dos clientes. GET lista (abertos primeiro, sem o print, que vem só
// por GET ?id= quando o admin pede para ver); POST muda o status; DELETE apaga.
async function reportes(req, res) {
  if (req.method === "GET" && req.query.id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.query.id))) return res.status(400).json({ error: "missing_id" });
    var um = await db.query("SELECT imagem FROM reportes WHERE id = $1", [String(req.query.id)]);
    if (!um.rows.length) return res.status(404).json({ error: "not_found" });
    return res.status(200).json({ imagem: um.rows[0].imagem });
  }
  if (req.method === "GET") {
    var r = await db.query(
      "SELECT id, email, tipo, texto, local, navegador, status, created_at, (imagem IS NOT NULL) AS tem_imagem " +
      "FROM reportes ORDER BY (status = 'aberto') DESC, created_at DESC LIMIT 300"
    );
    return res.status(200).json(r.rows.map(function (x) {
      return {
        id: x.id, email: x.email, tipo: x.tipo, texto: x.texto, local: x.local, navegador: x.navegador,
        status: x.status, criadoEm: x.created_at, temImagem: x.tem_imagem,
      };
    }));
  }
  var id = String((req.body && req.body.id) || req.query.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "missing_id" });
  if (req.method === "POST") {
    var status = req.body.status === "resolvido" ? "resolvido" : "aberto";
    var u = await db.query("UPDATE reportes SET status = $1 WHERE id = $2 RETURNING id", [status, id]);
    if (!u.rows.length) return res.status(404).json({ error: "not_found" });
    return res.status(200).json({ id: id, status: status });
  }
  if (req.method === "DELETE") {
    await db.query("DELETE FROM reportes WHERE id = $1", [id]);
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: "method_not_allowed" });
}

// Coloca ou tira um cliente da manutenção, sem afetar os demais.
async function manutencaoCliente(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({ error: "admin_sem_manutencao", message: "A conta de admin não entra em manutenção." });
  }
  var ligar = body.manutencao === true;
  var r = await db.query("UPDATE users SET manutencao = $1 WHERE email = $2 RETURNING id", [ligar, email]);
  if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
  return res.status(200).json({ email: email, manutencao: ligar });
}

var ACOES = {
  "manutencao-cliente": manutencaoCliente,
  reportes: reportes,
  cobranca: cobranca,
  clients: listarClientes,
  feedback: listarFeedback,
  aprovar: aprovar,
  "redefinir-senha": redefinirSenha,
  cliente: excluirCliente,
  numeros: numeros,
  config: salvarConfig,
  "aviso-cliente": avisoCliente,
};

module.exports = async function handler(req, res) {
  var acao = ACOES[req.query.acao];

  var session = auth.getSession(req);
  // 404 em vez de 403, e o mesmo 404 para ação inexistente: nem a existência
  // destas rotas é revelada a quem não é admin.
  if (!acao || !session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  try {
    return await acao(req, res);
  } catch (e) {
    console.error("admin/" + req.query.acao + " falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui completar agora."),
    });
  }
};
