const crypto = require("crypto");
const db = require("./_db");
const auth = require("./_auth");

// O que o admin ligou ou desligou no painel, lido por qualquer visitante — até
// sem conta, porque o aviso e o "cadastros fechados" valem já na tela de login.
// Nada aqui é segredo: são as mesmas informações que o app mostra na tela.
//
// Os campos pessoais são "meuAviso" e "minhaCobranca": o que o admin mandou só
// para esta conta. Saem do id da sessão (cookie assinado), nunca de algo que o
// navegador escolha, então ninguém lê o aviso ou a cobrança de outro cliente.
//
// O POST é o "Já paguei" do cliente. Mora aqui, e não num arquivo próprio,
// porque o plano gratuito da Vercel limita o projeto a 12 funções.
module.exports = async function handler(req, res) {
  try {
    var session = auth.getSession(req);

    var acao = req.method === "POST" && req.body ? req.body.acao : null;

    // Conectar o WhatsApp: código de 6 caracteres, vale 15 minutos, uso único.
    // Quem o manda para o número do agente liga aquele WhatsApp a esta conta.
    if (acao === "whatsapp-codigo" || acao === "whatsapp-desconectar") {
      if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });
      if (acao === "whatsapp-desconectar") {
        await db.query("UPDATE users SET whatsapp = NULL, wa_pendente = NULL, wa_ultimos = NULL WHERE id = $1", [session.uid]);
        return res.status(200).json({ ok: true });
      }
      var alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O e 1/I, que se confundem
      var bytes = crypto.randomBytes(6), codigo = "";
      for (var i = 0; i < 6; i++) codigo += alfabeto[bytes[i] % alfabeto.length];
      await db.query(
        "UPDATE users SET wa_codigo = $1, wa_codigo_ate = now() + interval '15 minutes' WHERE id = $2",
        [codigo, session.uid]
      );
      return res.status(200).json({ codigo: codigo, numero: process.env.WHATSAPP_NUMERO || null });
    }

    if (req.method === "POST") {
      if (!session || session.isAdmin) return res.status(401).json({ error: "not_authenticated" });
      // Só marca a data em que o cliente disse que pagou; quem tira a cobrança
      // é o admin, depois de conferir que o dinheiro entrou.
      var r = await db.query(
        "UPDATE users SET cobranca = jsonb_set(cobranca, '{pagoInformadoEm}', to_jsonb(now()::text)) " +
        "WHERE id = $1 AND cobranca IS NOT NULL RETURNING cobranca",
        [session.uid]
      );
      if (!r.rows.length) return res.status(404).json({ error: "sem_cobranca", message: "Não há cobrança em aberto." });
      return res.status(200).json({ minhaCobranca: r.rows[0].cobranca });
    }

    if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
    var cfg = await db.lerConfig();
    cfg.meuAviso = null;
    cfg.minhaCobranca = null;
    cfg.minhaManutencao = false;
    // O botão "WhatsApp" só aparece no app quando o agente está configurado.
    // O número é o público do agente (o mesmo que o cliente salva nos contatos).
    cfg.agenteWhatsapp = process.env.WHATSAPP_NUMERO && process.env.WHATSAPP_TOKEN
      ? String(process.env.WHATSAPP_NUMERO).replace(/\D/g, "") : null;
    cfg.meuWhatsapp = null;
    if (session && !session.isAdmin) {
      var u = await db.query("SELECT aviso, cobranca, manutencao, whatsapp, wa_ultimos FROM users WHERE id = $1", [session.uid]);
      if (u.rows.length) {
        cfg.meuAviso = u.rows[0].aviso || null;
        cfg.minhaCobranca = u.rows[0].cobranca || null;
        cfg.minhaManutencao = !!u.rows[0].manutencao;
        // Só o final do número: basta para a pessoa reconhecer o dela.
        var w = u.rows[0].whatsapp;
        cfg.meuWhatsapp = w ? "•••• " + w.slice(-4) : null;
        // Muda a cada lançamento (ou "desfazer") feito pelo WhatsApp: o app
        // aberto percebe e recarrega a lista sem a pessoa atualizar a página.
        var ult = u.rows[0].wa_ultimos;
        cfg.marcaWhatsapp = Array.isArray(ult) && ult.length ? ult[0] : null;
      }
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
