const crypto = require("crypto");
const db = require("./_db");
const auth = require("./_auth");

var TIPOS_REPORTE = ["erro", "melhoria", "ideia"];
var IMAGEM_MAX = 300 * 1024;

// "Reportar para o time": erro, melhoria ou ideia, com print opcional. Mora
// aqui, e não num arquivo próprio, porque o plano gratuito da Vercel limita o
// projeto a 12 funções. Ao contrário da avaliação, exige conta: o reporte é de
// quem usa o app, e o email (vindo da sessão, nunca do corpo) é o que permite
// responder depois.
async function receberReporte(req, res, body) {
  var session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: "not_authenticated", message: "Entre na sua conta para reportar." });

  var tipo = TIPOS_REPORTE.indexOf(body.tipo) >= 0 ? body.tipo : null;
  var texto = String(body.texto || "").trim().slice(0, 2000);
  if (!tipo) return res.status(400).json({ error: "tipo_invalido", message: "Escolha erro, melhoria ou ideia." });
  if (texto.length < 3) return res.status(400).json({ error: "texto_vazio", message: "Conte o que aconteceu." });

  // O print vira <img> no painel do admin: só imagem em data URL é aceita,
  // nada que o navegador pudesse interpretar como página ou script.
  var imagem = body.imagem ? String(body.imagem) : null;
  if (imagem && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imagem) || imagem.length > IMAGEM_MAX)) {
    return res.status(400).json({ error: "imagem_invalida", message: "Não consegui usar esse print — tenta outra imagem." });
  }

  var email;
  if (session.isAdmin) {
    email = process.env.ADMIN_EMAIL || "admin";
  } else {
    var user = await db.query("SELECT email FROM users WHERE id = $1", [session.uid]);
    if (!user.rows.length) return res.status(401).json({ error: "not_authenticated" });
    email = user.rows[0].email;
  }

  // Teto por conta: ninguém reporta 10 coisas por hora de boa-fé, e sem limite
  // uma conta encheria o banco de prints.
  var recentes = await db.query(
    "SELECT COUNT(*)::int AS total FROM reportes WHERE email = $1 AND created_at > now() - interval '1 hour'",
    [email]
  );
  if (recentes.rows[0].total >= 10) {
    return res.status(429).json({ error: "muitos_reportes", message: "Você já mandou vários reportes agora. Tente de novo mais tarde." });
  }

  await db.query(
    "INSERT INTO reportes (id, email, tipo, texto, imagem, local, navegador) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [crypto.randomUUID(), email, tipo, texto, imagem,
      String(body.local || "").slice(0, 120) || null, String(body.navegador || "").slice(0, 200) || null]
  );
  return res.status(200).json({ ok: true });
}

// Avaliação não exige conta. Exigir login aqui travava justamente quem o
// operador mais quer ouvir: a pessoa que abriu o link para experimentar e ainda
// não se cadastrou. Sem conta, o contato é opcional e vem de quem escreve.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var body = req.body || {};
  if (body.reporte) {
    try {
      return await receberReporte(req, res, body);
    } catch (e) {
      console.error("reporte falhou:", e);
      return res.status(500).json({
        error: "server_error",
        message: db.mensagemDeFalha(e, "Não consegui enviar agora. Tenta de novo."),
      });
    }
  }
  var rating = Number(body.rating);
  var comment = body.comment ? String(body.comment).trim().slice(0, 2000) : null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "invalid_rating", message: "Escolha uma nota de 1 a 5 estrelas." });
  }

  try {
    var session = auth.getSession(req);
    var email;

    if (session && session.isAdmin) {
      email = process.env.ADMIN_EMAIL || "admin";
    } else if (session) {
      // Com sessão, o email vem do banco e nunca do corpo da requisição: aceitá-lo
      // de fora deixaria qualquer um enviar avaliação se passando por outra conta.
      var user = await db.query("SELECT email FROM users WHERE id = $1", [session.uid]);
      email = user.rows.length ? user.rows[0].email : "anônimo";
    } else {
      // Sem sessão o contato é só um recado para resposta, não identidade: não
      // prova nada e não dá acesso a nada. Marcado como tal para o painel não
      // exibi-lo com o mesmo peso de um email verificado.
      var contato = String(body.contato || "").trim().slice(0, 254);
      email = contato ? contato + " (sem conta)" : "anônimo";
    }

    // Esta rota aceita escrita sem conta, então é a porta mais exposta do app:
    // sem teto, um script encheria a tabela sozinho. O limite é global e alto o
    // bastante para nenhuma pessoa real alcançá-lo — ninguém avalia 20 vezes
    // por minuto —, e não exige guardar IP de ninguém para funcionar.
    var recentes = await db.query(
      "SELECT COUNT(*)::int AS total FROM feedback WHERE created_at > now() - interval '1 minute'"
    );
    if (recentes.rows[0].total >= 20) {
      return res.status(429).json({
        error: "muitos_envios",
        message: "Muitas avaliações ao mesmo tempo. Tente de novo em um minuto.",
      });
    }

    var id = crypto.randomUUID();
    await db.query(
      "INSERT INTO feedback (id, email, rating, comment) VALUES ($1, $2, $3, $4)",
      [id, email, rating, comment || null]
    );
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("feedback falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui enviar agora. Tenta de novo."),
    });
  }
};
