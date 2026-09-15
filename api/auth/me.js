const db = require("../_db");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: "not_authenticated" });

  try {
    var result = await db.query("SELECT email FROM users WHERE id = $1", [session.uid]);
    if (!result.rows.length) {
      // Conta apagada depois que o cookie foi emitido: a sessão não vale mais.
      auth.clearSessionCookie(res);
      return res.status(401).json({ error: "not_authenticated" });
    }
    return res.status(200).json({ email: result.rows[0].email });
  } catch (e) {
    console.error("me falhou:", e);
    return res.status(500).json({ error: "server_error" });
  }
};
