const crypto = require("crypto");
const db = require("./_db");
const auth = require("./_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // O admin não tem linha na tabela "users" (é uma conta fixa por variável de
  // ambiente) — se ele tentasse mandar feedback, o FK de user_id quebraria.
  if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });

  var body = req.body || {};
  var rating = Number(body.rating);
  var comment = body.comment ? String(body.comment).trim().slice(0, 2000) : null;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "invalid_rating", message: "Escolha uma nota de 1 a 5 estrelas." });
  }

  try {
    var id = crypto.randomUUID();
    await db.query(
      "INSERT INTO feedback (id, user_id, rating, comment) VALUES ($1, $2, $3, $4)",
      [id, session.uid, rating, comment || null]
    );
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("feedback falhou:", e);
    return res.status(500).json({ error: "server_error", message: "Não consegui enviar agora. Tenta de novo." });
  }
};
