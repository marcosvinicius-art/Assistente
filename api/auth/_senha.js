const db = require("../_db");
const auth = require("../_auth");

// Troca da própria senha, com a senha atual por confirmação. Pedir a atual
// importa mesmo havendo sessão: impede que um aparelho deixado aberto vire
// uma conta tomada em dois cliques.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: "not_authenticated" });

  var body = req.body || {};
  var atual = String(body.atual || "");
  var nova = String(body.nova || "");

  if (!auth.validPassword(nova)) {
    return res.status(400).json({ error: "invalid_password", message: "A senha nova precisa de pelo menos 8 caracteres." });
  }

  // O admin não tem senha no banco: a dele é variável de ambiente, e trocá-la
  // aqui não teria efeito nenhum — mas a tela diria que funcionou.
  if (session.isAdmin) {
    return res.status(400).json({
      error: "admin_sem_senha_no_banco",
      message: "A senha do admin fica nas variáveis de ambiente da Vercel. Troque ADMIN_PASSWORD por lá.",
    });
  }

  try {
    var r = await db.query("SELECT password_hash FROM users WHERE id = $1", [session.uid]);
    if (!r.rows.length) return res.status(401).json({ error: "not_authenticated" });

    if (!auth.verifyPassword(atual, r.rows[0].password_hash)) {
      return res.status(401).json({ error: "senha_atual_errada", message: "A senha atual não confere." });
    }

    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [auth.hashPassword(nova), session.uid]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("auth/senha falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui trocar a senha agora."),
    });
  }
};
