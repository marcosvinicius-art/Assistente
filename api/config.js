const db = require("./_db");

// O que o admin ligou ou desligou no painel, lido por qualquer visitante — até
// sem conta, porque o aviso e o "cadastros fechados" valem já na tela de login.
// Nada aqui é segredo: são as mesmas informações que o app mostra na tela.
module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  try {
    return res.status(200).json(await db.lerConfig());
  } catch (e) {
    console.error("config falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui ler a configuração do site."),
    });
  }
};
