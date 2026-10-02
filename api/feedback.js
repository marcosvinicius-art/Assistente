const crypto = require("crypto");
const db = require("./_db");
const auth = require("./_auth");

// Avaliação não exige conta. Exigir login aqui travava justamente quem o
// operador mais quer ouvir: a pessoa que abriu o link para experimentar e ainda
// não se cadastrou. Sem conta, o contato é opcional e vem de quem escreve.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var body = req.body || {};
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
