// Retorna os reportes do próprio cliente — para a aba "Meus chamados"
// da central de suporte. Só lê, nunca expõe dados de outros usuários.
const db = require("./_db");
const auth = require("./_auth");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
    var session = auth.getSession(req);
    if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });
    var u = await db.query("SELECT email FROM users WHERE id = $1", [session.uid]);
    if (!u.rows.length) return res.status(404).json({ error: "not_found" });
    var r = await db.query(
      "SELECT id, tipo, texto, status, created_at FROM reportes WHERE email = $1 ORDER BY created_at DESC LIMIT 20",
      [u.rows[0].email]
    );
    return res.status(200).json(r.rows);
  } catch (e) {
    console.error("suporte falhou:", e);
    return res.status(500).json({ error: "server_error" });
  }
};
