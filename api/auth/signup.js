const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");

  if (!auth.validEmail(email)) {
    return res.status(400).json({ error: "invalid_email", message: "Email inválido." });
  }
  if (!auth.validPassword(password)) {
    return res.status(400).json({ error: "invalid_password", message: "A senha precisa de pelo menos 8 caracteres." });
  }
  // Sem isso, alguém criaria um cliente com o mesmo email do admin — o cadastro
  // ficaria pra sempre inacessível, porque o login sempre trata esse email como admin.
  if (auth.isAdminEmail(email)) {
    return res.status(409).json({ error: "email_in_use", message: "Já existe uma conta com este email." });
  }

  try {
    var existe = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existe.rows.length) {
      return res.status(409).json({ error: "email_in_use", message: "Já existe uma conta com este email." });
    }

    var id = crypto.randomUUID();
    var hash = auth.hashPassword(password);
    await db.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
      [id, email, hash]
    );

    auth.setSessionCookie(res, auth.createSessionToken(id));
    return res.status(200).json({ email: email });
  } catch (e) {
    console.error("signup falhou:", e);
    return res.status(500).json({ error: "server_error", message: "Não consegui criar a conta agora. Tenta de novo." });
  }
};
