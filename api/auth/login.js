const db = require("../_db");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");

  // O admin não é um cliente: não tem linha na tabela "users", é uma conta fixa
  // definida por variável de ambiente. Checado antes pra nem precisar tocar no banco.
  if (auth.isAdminEmail(email)) {
    if (!auth.verifyAdminPassword(password)) {
      return res.status(401).json({ error: "invalid_credentials", message: "Email ou senha incorretos." });
    }
    auth.setSessionCookie(res, auth.createSessionToken("admin", true));
    return res.status(200).json({ email: email, isAdmin: true });
  }

  try {
    var result = await db.query("SELECT id, password_hash FROM users WHERE email = $1", [email]);
    // Mesma mensagem pra email inexistente e senha errada — dizer qual dos dois
    // errou permite a quem tenta invadir descobrir emails cadastrados um a um.
    var invalido = { error: "invalid_credentials", message: "Email ou senha incorretos." };
    if (!result.rows.length) return res.status(401).json(invalido);

    var user = result.rows[0];
    if (!auth.verifyPassword(password, user.password_hash)) {
      return res.status(401).json(invalido);
    }

    auth.setSessionCookie(res, auth.createSessionToken(user.id));
    return res.status(200).json({ email: email });
  } catch (e) {
    console.error("login falhou:", e);
    return res.status(500).json({ error: "server_error", message: "Não consegui entrar agora. Tenta de novo." });
  }
};
