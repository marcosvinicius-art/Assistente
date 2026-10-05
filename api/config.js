const db = require("./_db");
const auth = require("./_auth");

// O que o admin ligou ou desligou no painel, lido por qualquer visitante — até
// sem conta, porque o aviso e o "cadastros fechados" valem já na tela de login.
// Nada aqui é segredo: são as mesmas informações que o app mostra na tela.
//
// O único campo pessoal é "meuAviso": o aviso que o admin mandou só para esta
// conta. Ele sai do id da sessão (cookie assinado), nunca de algo que o
// navegador escolha, então ninguém lê o aviso de outro cliente.
module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  try {
    var cfg = await db.lerConfig();
    cfg.meuAviso = null;
    var session = auth.getSession(req);
    if (session && !session.isAdmin) {
      var r = await db.query("SELECT aviso FROM users WHERE id = $1", [session.uid]);
      if (r.rows.length) cfg.meuAviso = r.rows[0].aviso || null;
    }
    return res.status(200).json(cfg);
  } catch (e) {
    console.error("config falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui ler a configuração do site."),
    });
  }
};
