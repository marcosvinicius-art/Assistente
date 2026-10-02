const db = require("../_db");
const auth = require("../_auth");

// Libera ou suspende o acesso de um cliente. Suspender em vez de excluir existe
// porque as duas coisas são diferentes: suspensa, a conta para de entrar mas
// guarda tudo; excluída, não volta.
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // 404 em vez de 403: não revela nem que a rota existe pra quem não é admin.
  if (!session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var aprovado = body.aprovado !== false;
  if (!email) return res.status(400).json({ error: "missing_email" });

  // O admin não se suspende: a sessão dele vem da variável de ambiente e
  // continuaria valendo, então o botão prometeria um efeito que não existe.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({
      error: "admin_sempre_liberado",
      message: "A conta de admin não depende de aprovação.",
    });
  }

  try {
    var r = await db.query(
      "UPDATE users SET aprovado = $1 WHERE email = $2 RETURNING id",
      [aprovado, email]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
    return res.status(200).json({ email: email, aprovado: aprovado });
  } catch (e) {
    console.error("admin/aprovar falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui salvar agora."),
    });
  }
};
