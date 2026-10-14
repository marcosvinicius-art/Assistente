// Salva a subscription de push do cliente no banco.
// Chamado pelo app após o usuário aceitar notificações.
const db = require("./_db");
const auth = require("./_auth");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    var session = auth.getSession(req);
    if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });
    var sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid_subscription" });
    await db.query("UPDATE users SET push_sub = $1 WHERE id = $2", [sub, session.uid]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("push falhou:", e);
    return res.status(500).json({ error: "server_error" });
  }
};
