const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");

// Redefinição feita pelo operador, não pelo próprio cliente. Sem provedor de
// email não há como mandar link de recuperação, e inventar uma "pergunta
// secreta" seria pior: vira mais uma coisa pra esquecer, e mais fraca que a
// senha que ela protege.
//
// A senha nova é gerada aqui e devolvida uma única vez, para o operador passar
// ao cliente pelo canal em que já estão falando.
var ALFABETO = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function senhaTemporaria() {
  // Alfabeto sem 0/O/1/l/I: a senha vai ser ditada ou digitada à mão, e esses
  // pares são lidos errado com frequência.
  var bytes = crypto.randomBytes(12);
  var fora = "";
  for (var i = 0; i < bytes.length; i++) fora += ALFABETO[bytes[i] % ALFABETO.length];
  return fora;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  var session = auth.getSession(req);
  // 404 em vez de 403: não revela nem que a rota existe pra quem não é admin.
  if (!session || !session.isAdmin) return res.status(404).json({ error: "not_found" });

  var email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "missing_email" });

  // O próprio admin não entra aqui: a senha dele é variável de ambiente, e a
  // linha no banco tem hash que não casa com nada. Redefini-la não faria efeito
  // nenhum e daria a impressão falsa de ter funcionado.
  if (auth.isAdminEmail(email)) {
    return res.status(400).json({
      error: "admin_nao_redefinivel",
      message: "A senha do admin fica nas variáveis de ambiente da Vercel, não aqui.",
    });
  }

  try {
    var nova = senhaTemporaria();
    var r = await db.query(
      "UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id",
      [auth.hashPassword(nova), email]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "Cliente não encontrado." });
    return res.status(200).json({ senha: nova });
  } catch (e) {
    console.error("admin/redefinir-senha falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui redefinir agora."),
    });
  }
};
