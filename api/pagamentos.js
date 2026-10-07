const db = require("./_db");
const auth = require("./_auth");
const mp = require("./_mercadopago");
const emails = require("./_email");

// Assinatura pelo Mercado Pago.
//   POST ?acao=assinar   { plano: "mensal"|"anual", metodo: "cartao"|"pix" }  → { url } do checkout
//   POST ?acao=cancelar  cancela a renovação no cartão (o acesso vai até o fim do período pago)
//   POST ?acao=webhook   avisos do Mercado Pago (pagamentos e assinaturas)
//
// Regra de ouro: acesso só é liberado depois de consultar o pagamento/assinatura
// na API do MP com o nosso token. O conteúdo do aviso só diz QUAL id consultar.

var MESES = { mensal: 1, anual: 12 };
var CARENCIA_DIAS = 3; // cobrança do cartão pode atrasar um pouco; não bloqueia na hora

function siteUrl(req) {
  return (process.env.SITE_URL || "https://" + req.headers.host).replace(/\/+$/, "");
}
function somaMeses(base, n) { var d = new Date(base); d.setMonth(d.getMonth() + n); return d; }

async function gravarAssinatura(userId, mudancas) {
  var r = await db.query("SELECT assinatura FROM users WHERE id = $1", [userId]);
  if (!r.rows.length) return null;
  var nova = Object.assign({}, r.rows[0].assinatura || {}, mudancas, { atualizadoEm: new Date().toISOString() });
  await db.query("UPDATE users SET assinatura = $1 WHERE id = $2", [nova, userId]);
  return nova;
}

async function assinar(req, res, session) {
  var body = req.body || {};
  var plano = MESES[body.plano] ? body.plano : null;
  var metodo = body.metodo === "pix" ? "pix" : body.metodo === "cartao" ? "cartao" : null;
  if (!plano || !metodo) return res.status(400).json({ error: "plano_invalido", message: "Escolha o plano e a forma de pagamento." });

  var u = (await db.query("SELECT id, email, teste_ate, assinatura FROM users WHERE id = $1", [session.uid])).rows[0];
  if (!u) return res.status(401).json({ error: "not_authenticated" });
  var cfg = await db.lerConfig();
  var valor = Math.round((plano === "anual" ? Number(cfg.precoAnual) : Number(cfg.precoMensal)) * 100) / 100;
  if (!(valor > 0)) return res.status(500).json({ error: "preco_invalido", message: "Preço do plano não configurado." });
  var titulo = "Wonner Sols — plano " + plano;
  var voltar = siteUrl(req) + "/?assinatura=retorno";

  if (metodo === "cartao") {
    var testeAte = u.teste_ate ? new Date(u.teste_ate) : null;
    var r = await mp.criarAssinatura({
      titulo: titulo, referencia: u.id, email: u.email, voltar: voltar,
      meses: MESES[plano], valor: valor,
      inicio: testeAte && testeAte > new Date() ? testeAte.toISOString() : null,
    });
    await gravarAssinatura(u.id, { status: "pendente", plano: plano, metodo: "cartao", mpId: r.id });
    return res.status(200).json({ url: r.init_point });
  }

  // Pix: a referência leva o plano; o valor esperado fica guardado para
  // conferir contra o que o MP disser que foi pago.
  var p = await mp.criarPix({
    titulo: titulo, referencia: u.id + ":" + plano, email: u.email, voltar: voltar,
    aviso: siteUrl(req) + "/api/pagamentos?acao=webhook", valor: valor,
  });
  await gravarAssinatura(u.id, { pixPendente: { plano: plano, valor: valor, em: new Date().toISOString() } });
  return res.status(200).json({ url: p.init_point });
}

async function cancelar(req, res, session) {
  var u = (await db.query("SELECT assinatura FROM users WHERE id = $1", [session.uid])).rows[0];
  var a = u && u.assinatura;
  if (!a || a.metodo !== "cartao" || !a.mpId) return res.status(400).json({ error: "sem_assinatura", message: "Não há assinatura no cartão para cancelar." });
  await mp.cancelarAssinatura(a.mpId);
  var nova = await gravarAssinatura(session.uid, { status: "cancelada" });
  return res.status(200).json({ assinatura: db.situacaoAssinatura({ cortesia: false, teste_ate: null, assinatura: nova }) });
}

// Assinatura no cartão: o estado vem sempre da API. "ate" = próxima cobrança +
// carência; cancelada ou pausada, mantém o "ate" já pago.
async function sincronizarAssinatura(preId) {
  var pre = await mp.lerAssinatura(preId);
  var uid = String(pre.external_reference || "");
  var u = (await db.query("SELECT assinatura FROM users WHERE id::text = $1", [uid])).rows[0];
  // Só a assinatura que esta conta criou: outra com a mesma referência não vale.
  if (!u || !u.assinatura || u.assinatura.mpId !== pre.id) return;
  var STATUS = { authorized: "ativa", paused: "pausada", cancelled: "cancelada", pending: "pendente" };
  var mud = { status: STATUS[pre.status] || pre.status };
  if (pre.status === "authorized" && pre.next_payment_date) {
    var ate = new Date(pre.next_payment_date);
    ate.setDate(ate.getDate() + CARENCIA_DIAS);
    var atual = u.assinatura.ate ? new Date(u.assinatura.ate) : null;
    if (!atual || ate > atual) mud.ate = ate.toISOString();
  }
  await gravarAssinatura(uid, mud);
}

async function processarPagamento(id) {
  var p = await mp.lerPagamento(id);
  var ref = String(p.external_reference || "");
  if (ref.indexOf(":") === -1) {
    // Cobrança de uma assinatura no cartão: atualiza pela própria assinatura.
    var preId = (p.metadata && p.metadata.preapproval_id) || p.preapproval_id;
    if (preId) await sincronizarAssinatura(preId);
    return;
  }
  if (p.status !== "approved") return;
  var partes = ref.split(":");
  var uid = partes[0], plano = partes[1];
  if (!MESES[plano]) return;
  var u = (await db.query("SELECT assinatura FROM users WHERE id::text = $1", [uid])).rows[0];
  if (!u) return;
  var pend = u.assinatura && u.assinatura.pixPendente;
  // Pagou menos que o combinado (ou não havia Pix pedido): não libera.
  if (!pend || pend.plano !== plano || Number(p.transaction_amount) + 0.01 < Number(pend.valor)) {
    console.error("pagamentos: Pix " + id + " não confere com o pedido da conta " + uid);
    return;
  }
  // Uma vez por pagamento: o MP reenvia o mesmo aviso.
  var novo = await db.query("INSERT INTO pagamentos_mp (id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id", [String(p.id), uid]);
  if (!novo.rows.length) return;
  var base = u.assinatura.ate && new Date(u.assinatura.ate) > new Date() ? new Date(u.assinatura.ate) : new Date();
  await gravarAssinatura(uid, {
    status: "ativa", plano: plano, metodo: "pix", pixPendente: null,
    ate: somaMeses(base, MESES[plano]).toISOString(),
  });
}

async function webhook(req, res) {
  var q = req.query || {}, b = req.body || {};
  var tipo = String(b.type || q.type || q.topic || "");
  var id = (b.data && b.data.id) || q["data.id"] || q.id;
  if (!id) return res.status(200).json({ ok: true });
  if (!mp.avisoAutentico(req, id)) return res.status(401).json({ error: "assinatura_invalida" });

  if (tipo === "payment") await processarPagamento(id);
  else if (tipo === "subscription_preapproval" || tipo === "preapproval") await sincronizarAssinatura(id);
  else if (tipo === "subscription_authorized_payment") {
    var cobranca = await mp.lerCobrancaDaAssinatura(id);
    if (cobranca && cobranca.preapproval_id) await sincronizarAssinatura(cobranca.preapproval_id);
  }
  return res.status(200).json({ ok: true });
}

// Uma vez por dia (cron da Vercel, ver vercel.json): avisa por e-mail quem tem
// o teste grátis acabando nas próximas ~24h e ainda não assinou. Uma vez só.
async function lembretes(req, res) {
  var segredo = process.env.CRON_SECRET;
  if (!segredo || req.headers.authorization !== "Bearer " + segredo) return res.status(401).json({ error: "nao_autorizado" });
  if (!emails.configurado()) return res.status(200).json({ ok: true, enviados: 0, motivo: "email nao configurado" });
  var r = await db.query(
    "SELECT id, email, teste_ate FROM users WHERE aprovado AND NOT cortesia AND lembrete_teste_em IS NULL " +
    "AND teste_ate BETWEEN now() + interval '12 hours' AND now() + interval '36 hours' " +
    "AND (assinatura IS NULL OR assinatura->>'ate' IS NULL OR (assinatura->>'ate')::timestamptz < now()) LIMIT 200"
  );
  var enviados = 0;
  for (var i = 0; i < r.rows.length; i++) {
    var u = r.rows[i];
    var ok = await emails.enviar(u.email, "Seu teste grátis acaba amanhã", [
      "Seu período grátis no Wonner Sols termina amanhã. Para continuar lançando seus gastos, escolha um plano — leva um minuto, no cartão ou no Pix.",
      "Seus dados continuam guardados de qualquer jeito.",
    ], { texto: "Escolher meu plano", url: emails.siteUrl(req) });
    if (ok.enviado) {
      enviados++;
      await db.query("UPDATE users SET lembrete_teste_em = now() WHERE id = $1", [u.id]);
    }
  }
  return res.status(200).json({ ok: true, enviados: enviados });
}

module.exports = async function handler(req, res) {
  if ((req.query || {}).acao === "lembretes") {
    try { return await lembretes(req, res); }
    catch (e) { console.error("pagamentos/lembretes falhou:", e && e.message); return res.status(500).json({ error: "server_error" }); }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!mp.configurado()) return res.status(503).json({ error: "pagamento_nao_configurado", message: "Pagamentos ainda não estão ligados." });
  var acao = (req.query || {}).acao;
  try {
    if (acao === "webhook") return await webhook(req, res);
    var session = auth.getSession(req);
    if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });
    if (acao === "assinar") return await assinar(req, res, session);
    if (acao === "cancelar") return await cancelar(req, res, session);
    return res.status(404).json({ error: "not_found" });
  } catch (e) {
    console.error("pagamentos/" + acao + " falhou:", e && e.message);
    // No webhook, erro vira 500 de propósito: o MP tenta de novo mais tarde.
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui falar com o Mercado Pago agora. Tenta de novo."),
    });
  }
};
