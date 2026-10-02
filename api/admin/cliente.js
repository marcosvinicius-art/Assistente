const db = require("../_db");
const auth = require("../_auth");

// Exclusão definitiva de uma conta de cliente. Devolve o que foi apagado, para
// a tela poder dizer o tamanho do estrago em vez de um "pronto" vago.
module.exports = async function handler(req, res) {
  if (req.method !== "DELETE") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // 404 em vez de 403: não revela nem que a rota existe pra quem não é admin.
  if (!session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  var email = String(req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  // O admin não se apaga. A conta dele existe só para guardar os próprios
  // dados, e sem ela o login seguinte a recriaria vazia — dando a impressão de
  // ter perdido tudo sem motivo.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({
      error: "admin_nao_excluivel",
      message: "A conta de admin não pode ser excluída por aqui.",
    });
  }

  try {
    var alvo = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    if (!alvo.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
    var userId = alvo.rows[0].id;

    var contagem = await db.query(
      "SELECT kind, COUNT(*)::int AS total FROM records WHERE user_id = $1 GROUP BY kind",
      [userId]
    );
    var porTipo = {};
    contagem.rows.forEach(function (r) { porTipo[r.kind] = r.total; });

    // A avaliação é anonimizada, não apagada: o email sai (é o dado pessoal), o
    // conteúdo fica. Apagar junto destruiria a opinião sobre o produto, que não
    // identifica mais ninguém depois que o email some.
    var anon = await db.query(
      "UPDATE feedback SET email = 'conta excluída' WHERE email = $1 OR email = $2",
      [email, email + " (sem conta)"]
    );

    // records some por ON DELETE CASCADE na chave estrangeira — uma transação a
    // menos e sem risco de sobrar registro órfão se algo falhar no meio.
    await db.query("DELETE FROM users WHERE id = $1", [userId]);

    return res.status(200).json({
      email: email,
      lancamentos: porTipo.transaction || 0,
      metas: porTipo.goal || 0,
      investimentos: porTipo.investment || 0,
      cartoes: porTipo.card || 0,
      avaliacoesAnonimizadas: anon.rowCount || 0,
    });
  } catch (e) {
    console.error("admin/cliente falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui excluir agora."),
    });
  }
};
