// Conversa com a WhatsApp Cloud API (Meta): enviar texto, enviar modelo
// aprovado, baixar mídia e conferir a assinatura dos avisos que a Meta manda.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   WHATSAPP_TOKEN          token de acesso do app na Meta (permanente, de usuário do sistema)
//   WHATSAPP_PHONE_ID       "Phone number ID" do número do agente
//   WHATSAPP_APP_SECRET     "App secret" do app na Meta — confere que o aviso veio mesmo dela
//   WHATSAPP_VERIFY_TOKEN   texto qualquer, igual ao digitado no painel da Meta ao ligar o webhook
//   WHATSAPP_NUMERO         número do agente só com dígitos (ex.: 5511999998888), para o link wa.me
//   WHATSAPP_TEMPLATE_COBRANCA / WHATSAPP_TEMPLATE_AVISO   (opcionais) nomes dos modelos aprovados
// Veja WHATSAPP.md para o passo a passo.
const crypto = require("crypto");

var VERSAO = process.env.WHATSAPP_API_VERSION || "v23.0";

function configurado() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_APP_SECRET);
}

// A Meta assina cada aviso com HMAC-SHA256 do corpo cru, usando o App Secret.
// Sem conferir isso, qualquer um que descobrisse o endereço poderia mandar
// "mensagens" se passando por um cliente e lançar na conta dele.
function assinaturaValida(corpoCru, cabecalho) {
  var segredo = process.env.WHATSAPP_APP_SECRET;
  if (!segredo || !cabecalho || !corpoCru) return false;
  var esperado = "sha256=" + crypto.createHmac("sha256", segredo).update(corpoCru).digest("hex");
  var a = Buffer.from(esperado), b = Buffer.from(String(cabecalho));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function chamar(caminho, corpo) {
  var resp = await fetch("https://graph.facebook.com/" + VERSAO + "/" + caminho, {
    method: corpo ? "POST" : "GET",
    headers: Object.assign(
      { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN },
      corpo ? { "Content-Type": "application/json" } : {}
    ),
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  var dados = await resp.json().catch(function () { return null; });
  if (!resp.ok) {
    var e = new Error((dados && dados.error && dados.error.message) || ("WhatsApp respondeu " + resp.status));
    e.codigo = dados && dados.error && dados.error.code;
    throw e;
  }
  return dados;
}

function enviarTexto(para, texto) {
  return chamar(process.env.WHATSAPP_PHONE_ID + "/messages", {
    messaging_product: "whatsapp",
    to: para,
    type: "text",
    text: { body: String(texto).slice(0, 4000), preview_url: false },
  });
}

// Fora da janela de 24h desde a última mensagem do cliente, a Meta só deixa a
// empresa puxar conversa com um modelo aprovado. Com o modelo configurado ele é
// usado; sem, vai texto comum — que só chega se o cliente falou com o agente
// nas últimas 24h.
async function enviarParaCliente(para, texto, nomeModelo, parametros) {
  if (nomeModelo) {
    return chamar(process.env.WHATSAPP_PHONE_ID + "/messages", {
      messaging_product: "whatsapp",
      to: para,
      type: "template",
      template: {
        name: nomeModelo,
        language: { code: "pt_BR" },
        components: [{ type: "body", parameters: parametros.map(function (p) { return { type: "text", text: String(p).slice(0, 900) }; }) }],
      },
    });
  }
  return enviarTexto(para, texto);
}

// Foto ou PDF que o cliente mandou, como data URL — o mesmo formato do
// comprovante feito pelo app. Acima do limite volta null: a Meta já entrega a
// foto comprimida, e o servidor não tem como reduzi-la mais.
async function baixarMidia(mediaId, limiteBytes) {
  var info = await chamar(encodeURIComponent(mediaId));
  var tipo = String(info.mime_type || "").split(";")[0];
  if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(tipo)) return null;
  if (info.file_size && info.file_size > limiteBytes) return null;
  var resp = await fetch(info.url, { headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN } });
  if (!resp.ok) return null;
  var buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > limiteBytes) return null;
  return { dados: "data:" + tipo + ";base64," + buf.toString("base64"), tipo: tipo };
}

module.exports = { configurado, assinaturaValida, enviarTexto, enviarParaCliente, baixarMidia };
