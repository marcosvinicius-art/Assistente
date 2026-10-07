// E-mails pelo Resend (resend.com). Desligado até existirem as variáveis:
//   RESEND_API_KEY   chave da API do Resend
//   EMAIL_REMETENTE  ex.: "Wonner Sols <nao-responda@seudominio.com.br>" — o domínio
//                    precisa estar verificado no Resend (senão o e-mail cai no spam ou nem sai)
// Veja EMAILS.md.

function configurado() { return !!(process.env.RESEND_API_KEY && process.env.EMAIL_REMETENTE); }

function escapar(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Um modelo só, simples e legível em qualquer cliente de e-mail (inclusive no
// celular e no modo escuro): título, parágrafos e um botão opcional.
function modelo(titulo, paragrafos, botao) {
  var corpo = paragrafos.map(function (p) {
    return '<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2937">' + escapar(p) + "</p>";
  }).join("");
  var cta = botao
    ? '<p style="margin:22px 0"><a href="' + escapar(botao.url) + '" style="display:inline-block;background:#00417F;color:#ffffff;' +
      'text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">' + escapar(botao.texto) + "</a></p>" +
      '<p style="margin:0 0 14px;font-size:12px;color:#6b7280">Se o botão não abrir, copie este endereço: ' + escapar(botao.url) + "</p>"
    : "";
  return '<div style="background:#f4f6f9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 26px;border-top:4px solid #001539">' +
    '<p style="margin:0 0 18px;font-size:18px;font-weight:800;color:#001539">Wonner Sols</p>' +
    '<h1 style="margin:0 0 16px;font-size:20px;color:#111827">' + escapar(titulo) + "</h1>" + corpo + cta +
    '<p style="margin:22px 0 0;font-size:12px;color:#9ca3af">Você recebeu este e-mail porque tem uma conta no Wonner Sols.</p>' +
    "</div></div>";
}

function textoPuro(titulo, paragrafos, botao) {
  return titulo + "\n\n" + paragrafos.join("\n\n") + (botao ? "\n\n" + botao.texto + ": " + botao.url : "");
}

// Nunca lança: um e-mail que não sai não pode desfazer a ação que o motivou
// (a conta continua liberada, a cobrança continua no app). Devolve o resultado.
async function enviar(para, titulo, paragrafos, botao) {
  if (!configurado()) return { enviado: false, motivo: "email nao configurado" };
  try {
    var resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_REMETENTE,
        to: [para],
        subject: titulo,
        html: modelo(titulo, paragrafos, botao),
        text: textoPuro(titulo, paragrafos, botao),
      }),
    });
    if (!resp.ok) {
      var erro = await resp.json().catch(function () { return null; });
      console.error("email: Resend respondeu " + resp.status, erro && erro.message);
      return { enviado: false, motivo: (erro && erro.message) || "Resend " + resp.status };
    }
    return { enviado: true };
  } catch (e) {
    console.error("email: falha ao enviar", e && e.message);
    return { enviado: false, motivo: "falha de rede" };
  }
}

function siteUrl(req) {
  return (process.env.SITE_URL || "https://" + req.headers.host).replace(/\/+$/, "");
}

module.exports = { configurado, enviar, siteUrl };
