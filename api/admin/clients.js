const db = require("../_db");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // 404 em vez de 403: não revela nem que a rota existe pra quem não é admin.
  if (!session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  try {
    var result = await db.query(
      "SELECT email, created_at FROM users ORDER BY created_at DESC"
    );
    return res.status(200).json(result.rows.map(function (r) {
      return { email: r.email, criadoEm: r.created_at };
    }));
  } catch (e) {
    console.error("admin/clients falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui carregar a lista agora."),
    });
  }
};
