// Diagnóstico de configuração. Responde o que está faltando pra o backend
// funcionar, sem precisar abrir o log da Vercel.
//
// Só diz SE cada variável existe — nunca o valor. Um "true" aqui não vaza segredo
// nenhum, e sem isso a única saída é adivinhar qual das quatro ficou de fora.
const db = require("./_db");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  var segredo = process.env.SESSION_SECRET || "";
  var config = {
    banco: !!db.stringDeConexao(),
    sessionSecret: segredo.length >= 16,
    adminEmail: !!process.env.ADMIN_EMAIL,
    adminPassword: !!process.env.ADMIN_PASSWORD,
  };

  var banco = { conecta: false, detalhe: null };
  try {
    await db.query("SELECT 1");
    banco.conecta = true;
  } catch (e) {
    // e.message de um erro de conexão pode trazer host e usuário do banco: só o
    // código curto sai daqui, exceto quando é a nossa própria mensagem de config.
    banco.detalhe = e && e.configMissing ? e.message : (e && e.code) || "falha ao conectar";
  }

  var faltando = Object.keys(config).filter(function (k) { return !config[k]; });
  return res.status(200).json({
    ok: banco.conecta && !faltando.length,
    config: config,
    banco: banco,
    faltando: faltando,
  });
};
