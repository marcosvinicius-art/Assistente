// Conversa com a API do Mercado Pago. Veja ASSINATURA.md para configurar.
//   MERCADOPAGO_ACCESS_TOKEN    credencial de produção (ou de teste) da sua conta
//   MERCADOPAGO_WEBHOOK_SECRET  "assinatura secreta" dos webhooks (painel do MP)
//   SITE_URL                    (opcional) endereço público, ex.: https://wonnersols.vercel.app
const crypto = require("crypto");

function configurado() { return !!process.env.MERCADOPAGO_ACCESS_TOKEN; }

async function chamar(metodo, caminho, corpo) {
  var resp = await fetch("https://api.mercadopago.com" + caminho, {
    method: metodo,
    headers: Object.assign(
      { Authorization: "Bearer " + process.env.MERCADOPAGO_ACCESS_TOKEN },
      corpo ? { "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() } : {}
    ),
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  var dados = await resp.json().catch(function () { return null; });
  if (!resp.ok) {
    var e = new Error((dados && (dados.message || dados.error)) || ("Mercado Pago respondeu " + resp.status));
    e.status = resp.status;
    throw e;
  }
  return dados;
}

// Assinatura recorrente no cartão (sem plano, pagamento pendente): o MP devolve
// um link (init_point) onde o cliente põe o cartão e autoriza.
function criarAssinatura(o) {
  var corpo = {
    reason: o.titulo,
    external_reference: o.referencia,
    payer_email: o.email,
    back_url: o.voltar,
    status: "pending",
    auto_recurring: {
      frequency: o.meses,
      frequency_type: "months",
      transaction_amount: o.valor,
      currency_id: "BRL",
    },
  };
  // Assinou ainda no teste: a primeira cobrança só no fim dele.
  if (o.inicio) corpo.auto_recurring.start_date = o.inicio;
  return chamar("POST", "/preapproval", corpo);
}

function lerAssinatura(id) { return chamar("GET", "/preapproval/" + encodeURIComponent(id)); }
function cancelarAssinatura(id) { return chamar("PUT", "/preapproval/" + encodeURIComponent(id), { status: "cancelled" }); }

// Pix: pagamento avulso (Checkout Pro) de um período. Só Pix é oferecido —
// cartão ali viraria uma cobrança que não renova, confundindo com a assinatura.
function criarPix(o) {
  return chamar("POST", "/checkout/preferences", {
    items: [{ title: o.titulo, quantity: 1, unit_price: o.valor, currency_id: "BRL" }],
    payer: { email: o.email },
    external_reference: o.referencia,
    notification_url: o.aviso,
    back_urls: { success: o.voltar, pending: o.voltar, failure: o.voltar },
    auto_return: "approved",
    payment_methods: {
      excluded_payment_types: [{ id: "credit_card" }, { id: "debit_card" }, { id: "ticket" }, { id: "prepaid_card" }],
      installments: 1,
    },
  });
}

function lerPagamento(id) { return chamar("GET", "/v1/payments/" + encodeURIComponent(id)); }
// Cada cobrança mensal/anual de uma assinatura; aponta para a assinatura (preapproval_id).
function lerCobrancaDaAssinatura(id) { return chamar("GET", "/authorized_payments/" + encodeURIComponent(id)); }

// Confere o x-signature do aviso. Mesmo assim, nada é liberado pelo conteúdo
// do aviso: o recurso é sempre buscado de novo na API com o nosso token.
function avisoAutentico(req, dataId) {
  var segredo = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!segredo) return true; // sem segredo configurado, vale só a re-consulta à API
  var cab = String(req.headers["x-signature"] || "");
  var partes = {};
  cab.split(",").forEach(function (p) { var kv = p.split("="); if (kv.length === 2) partes[kv[0].trim()] = kv[1].trim(); });
  if (!partes.ts || !partes.v1) return false;
  var manifesto = "id:" + String(dataId).toLowerCase() + ";request-id:" + (req.headers["x-request-id"] || "") + ";ts:" + partes.ts + ";";
  var esperado = crypto.createHmac("sha256", segredo).update(manifesto).digest("hex");
  var a = Buffer.from(esperado), b = Buffer.from(partes.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configurado, criarAssinatura, lerAssinatura, cancelarAssinatura, criarPix, lerPagamento, lerCobrancaDaAssinatura, avisoAutentico };
