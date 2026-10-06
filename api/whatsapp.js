const db = require("./_db");
const wa = require("./_whatsapp");
const agente = require("./_agente");

// Endereço que a Meta chama (webhook do WhatsApp Cloud API).
//   GET  — verificação, uma vez, quando o webhook é ligado no painel da Meta.
//   POST — cada mensagem que um cliente manda para o número do agente.
// Responde 200 sempre que o aviso é autêntico, mesmo se algo falhar ao tratar a
// mensagem: com erro, a Meta reenviaria o mesmo aviso por horas.

var LIMITE_COMPROVANTE = 230 * 1024; // vira ~300 KB em base64, o teto por registro

function lerCorpoCru(req) {
  return new Promise(function (ok) {
    if (req.readableEnded || req.complete && !req.readable) return ok("");
    var partes = [];
    var fim = setTimeout(function () { ok(Buffer.concat(partes).toString("utf8")); }, 3000);
    req.on("data", function (p) { partes.push(p); });
    req.on("end", function () { clearTimeout(fim); ok(Buffer.concat(partes).toString("utf8")); });
    req.on("error", function () { clearTimeout(fim); ok(""); });
  });
}

// A Vercel pode já ter lido o corpo para montar req.body. Nesse caso a
// assinatura é conferida contra as formas em que a Meta serializa o JSON
// (acentos como \uXXXX e barras como \/) — se nenhuma bater, o aviso é recusado.
function candidatosDoCorpo(corpo) {
  var base = JSON.stringify(corpo);
  var unicode = base.replace(/[\u007f-￿]/g, function (c) { return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4); });
  return [base, unicode, unicode.replace(/\//g, "\\/"), base.replace(/\//g, "\\/")];
}

async function tratarMensagem(m) {
  // Só uma vez por mensagem: o reenvio da Meta cai aqui e para.
  var nova = await db.query("INSERT INTO wa_mensagens (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [m.id]);
  if (!nova.rows.length) return;

  var de = String(m.from || "").replace(/\D/g, "");
  var texto = m.type === "text" ? String((m.text && m.text.body) || "") : "";
  var r = await db.query(
    "SELECT id, email, aprovado, manutencao, wa_pendente, wa_ultimos FROM users WHERE whatsapp = $1", [de]
  );

  if (!r.rows.length) {
    // Número ainda não conectado: a única coisa aceita é o código do app, como
    // a mensagem inteira — procurado no meio do texto, "GASTEI" virava código.
    var cod = texto.trim().toUpperCase().match(/^(?:CONECTAR\s+)?([A-Z0-9]{6})$/);
    if (cod) {
      var ligado = await db.query(
        "UPDATE users SET whatsapp = $1, wa_codigo = NULL, wa_codigo_ate = NULL " +
        "WHERE wa_codigo = $2 AND wa_codigo_ate > now() RETURNING email",
        [de, cod[1]]
      );
      if (ligado.rows.length) {
        return wa.enviarTexto(de, "🔗 Pronto! Este WhatsApp está conectado à conta *" + ligado.rows[0].email + "*.\n\n" + agente.AJUDA);
      }
      return wa.enviarTexto(de, "Esse código não vale (errado ou vencido). Gere outro no app: botão *WhatsApp*, no topo.");
    }
    return wa.enviarTexto(de,
      "Olá! Sou o assistente do *Wonner Sols*. Para eu mexer na sua conta, conecte este WhatsApp:\n" +
      "abra o app, toque em *WhatsApp* no topo e mande para mim o código que aparecer.");
  }

  var user = r.rows[0];
  if (user.aprovado === false) return wa.enviarTexto(de, "Sua conta ainda não foi liberada. Você recebe um aviso assim que for.");
  if (await db.clienteEmManutencao(user.id)) {
    return wa.enviarTexto(de, "O Wonner Sols está em manutenção. Volte daqui a pouco — seus dados estão guardados.");
  }

  var norm = texto.trim().toLowerCase();
  if (norm === "desconectar") {
    await db.query("UPDATE users SET whatsapp = NULL, wa_pendente = NULL, wa_ultimos = NULL WHERE id = $1", [user.id]);
    return wa.enviarTexto(de, "Desconectado. Para voltar, gere um código novo no app.");
  }

  var msg;
  if (m.type === "text") {
    msg = { texto: texto };
  } else if (m.type === "image" || m.type === "document") {
    var midia = m.image || m.document || {};
    var arquivo = await wa.baixarMidia(midia.id, LIMITE_COMPROVANTE).catch(function () { return null; });
    msg = arquivo ? { foto: arquivo, legenda: midia.caption } : { fotoGrande: true, legenda: midia.caption };
  } else {
    return wa.enviarTexto(de, "Por enquanto eu entendo texto e foto/PDF de comprovante. Mande *ajuda* para ver o que eu faço.");
  }
  return wa.enviarTexto(de, await agente.responder(user, msg));
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    var q = req.query || {};
    if (q["hub.mode"] === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN &&
        q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(String(q["hub.challenge"] || ""));
    }
    return res.status(403).json({ error: "forbidden" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!wa.configurado()) return res.status(503).json({ error: "whatsapp_nao_configurado" });

  var assinatura = req.headers["x-hub-signature-256"];
  var cru = await lerCorpoCru(req);
  var corpo;
  if (cru) {
    if (!wa.assinaturaValida(cru, assinatura)) return res.status(401).json({ error: "assinatura_invalida" });
    try { corpo = JSON.parse(cru); } catch (e) { return res.status(400).json({ error: "json_invalido" }); }
  } else {
    corpo = req.body || {};
    var confere = candidatosDoCorpo(corpo).some(function (c) { return wa.assinaturaValida(c, assinatura); });
    if (!confere) {
      console.error("whatsapp: assinatura não confere (corpo já lido pela plataforma)");
      return res.status(401).json({ error: "assinatura_invalida" });
    }
  }

  var mensagens = [];
  (corpo.entry || []).forEach(function (e) {
    (e.changes || []).forEach(function (c) {
      var v = c.value || {};
      // Só mensagens para o número deste agente (o mesmo app pode ter outros).
      if (v.metadata && process.env.WHATSAPP_PHONE_ID && v.metadata.phone_number_id !== process.env.WHATSAPP_PHONE_ID) return;
      (v.messages || []).forEach(function (m) { mensagens.push(m); });
    });
  });

  for (var i = 0; i < mensagens.length; i++) {
    try {
      await tratarMensagem(mensagens[i]);
    } catch (e) {
      console.error("whatsapp: falha ao tratar mensagem", mensagens[i].id, e && e.message);
    }
  }
  return res.status(200).json({ ok: true });
};
