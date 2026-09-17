const db = require("../_db");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // 404 em vez de 403: não revela nem que a rota existe pra quem não é admin.
  if (!session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  try {
    var result = await db.query(
      "SELECT u.email, f.rating, f.comment, f.created_at " +
      "FROM feedback f JOIN users u ON u.id = f.user_id " +
      "ORDER BY f.created_at DESC"
    );
    return res.status(200).json(result.rows.map(function (r) {
      return { email: r.email, rating: r.rating, comment: r.comment, criadoEm: r.created_at };
    }));
  } catch (e) {
    console.error("admin/feedback falhou:", e);
    return res.status(500).json({ error: "server_error" });
  }
};
