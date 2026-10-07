const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");
const email = require("../_email");

// "Esqueci minha senha": manda um link de uso único, válido por 1 hora.
//   POST { email }            → sempre a mesma resposta, exista a conta ou não
//   POST { token, senha }     → (acao "redefinir") troca a senha pelo link
var VALIDADE_MIN = 60;
var INTERVALO_MIN = 2; // um pedido por conta a cada 2 minutos

function hashToken(t) { return crypto.createHash("sha256").update(String(t)).digest("hex"); }

async function pedir(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!email.configurado()) {
    return res.status(503).json({ error: "email_nao_configurado", message: "Recuperação por e-mail ainda não está ligada." });
  }
  var endereco = String((req.body || {}).email || "").trim().toLowerCase();
  // Mesma resposta para conta existente ou não: senão o formulário viraria um
  // jeito de descobrir quem tem conta no app.
  var resposta = { ok: true, message: "Se houver uma conta com esse e-mail, enviamos um link para criar uma senha nova. Confira também o spam." };
  if (!auth.validEmail(endereco) || auth.isAdminEmail(endereco)) return res.status(200).json(resposta);

  try {
    var token = crypto.randomBytes(32).toString("hex");
    var r = await db.query(
      "UPDATE users SET reset_hash = $1, reset_ate = now() + ($2 || ' minutes')::interval, reset_pedido_em = now() " +
      "WHERE email = $3 AND (reset_pedido_em IS NULL OR reset_pedido_em < now() - ($4 || ' minutes')::interval) RETURNING id",
      [hashToken(token), String(VALIDADE_MIN), endereco, String(INTERVALO_MIN)]
    );
    if (r.rows.length) {
      await email.enviar(endereco, "Criar uma senha nova", [
        "Recebemos um pedido para criar uma senha nova para a sua conta.",
        "O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.",
      ], { texto: "Criar senha nova", url: email.siteUrl(req) + "/?redefinir=" + token });
    }
    return res.status(200).json(resposta);
  } catch (e) {
    console.error("auth/esqueci falhou:", e && e.message);
    return res.status(500).json({ error: "server_error", message: db.mensagemDeFalha(e, "Não consegui enviar agora. Tenta de novo.") });
  }
}

async function redefinir(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  var body = req.body || {};
  var token = String(body.token || "");
  var senha = String(body.senha || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ error: "link_invalido", message: "Esse link não é válido. Peça um novo." });
  if (!auth.validPassword(senha)) return res.status(400).json({ error: "invalid_password", message: "A senha nova precisa de pelo menos 8 caracteres." });
  try {
    // Uso único: o token some na mesma consulta que troca a senha. Também
    // destrava a conta (falhas de login acumuladas não valem mais).
    var r = await db.query(
      "UPDATE users SET password_hash = $1, reset_hash = NULL, reset_ate = NULL, falhas = 0, travado_ate = NULL " +
      "WHERE reset_hash = $2 AND reset_ate > now() RETURNING email",
      [auth.hashPassword(senha), hashToken(token)]
    );
    if (!r.rows.length) return res.status(400).json({ error: "link_invalido", message: "Esse link venceu ou já foi usado. Peça um novo em \"Esqueci minha senha\"." });
    return res.status(200).json({ ok: true, email: r.rows[0].email });
  } catch (e) {
    console.error("auth/redefinir falhou:", e && e.message);
    return res.status(500).json({ error: "server_error", message: db.mensagemDeFalha(e, "Não consegui trocar a senha agora.") });
  }
}

module.exports = { pedir, redefinir };
