const crypto = require("crypto");
const db = require("./_db");
const auth = require("./_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: "not_authenticated" });

  var body = req.body || {};
  var rating = Number(body.rating);
  var comment = body.comment ? String(body.comment).trim().slice(0, 2000) : null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "invalid_rating", message: "Escolha uma nota de 1 a 5 estrelas." });
  }

  try {
    // O email vem sempre do servidor, nunca do que o cliente mandou no corpo da
    // requisição — senão qualquer um poderia mandar feedback se passando por outro.
    var email;
    if (session.isAdmin) {
      email = process.env.ADMIN_EMAIL || "admin";
    } else {
      var user = await db.query("SELECT email FROM users WHERE id = $1", [session.uid]);
      if (!user.rows.length) return res.status(401).json({ error: "not_authenticated" });
      email = user.rows[0].email;
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
