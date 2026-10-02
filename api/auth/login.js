const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");

// O admin também usa o app: lança, acompanha metas, cadastra cartão. Para isso
// precisa de uma linha em "users", porque é o id dela que vai em todo registro —
// antes a sessão dele levava a string "admin", que não é UUID e fazia qualquer
// consulta de dados quebrar.
//
// A senha gravada aqui não casa com nada: quem autentica o admin continua sendo
// a variável de ambiente, nunca esta linha. verifyPassword devolve false para
// hash sem o formato "salt:hash", então o login comum neste email é impossível.
async function garantirContaDoAdmin(email) {
  var achou = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (achou.rows.length) return achou.rows[0].id;
  var id = crypto.randomUUID();
  await db.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [id, email, "sem-senha-propria"]
  );
  return id;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");

  try {
    // Quem decide se é admin é a variável de ambiente, conferida antes de
    // qualquer consulta ao banco. A conta serve só para guardar os dados dele.
    if (auth.isAdminEmail(email)) {
      if (!auth.verifyAdminPassword(password)) {
        return res.status(401).json({ error: "invalid_credentials", message: "Email ou senha incorretos." });
      }
      var adminId = await garantirContaDoAdmin(email);
      auth.setSessionCookie(res, auth.createSessionToken(adminId, true));
      return res.status(200).json({ email: email, isAdmin: true });
    }

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
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui entrar agora. Tenta de novo."),
    });
  }
};
