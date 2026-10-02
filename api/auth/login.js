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
  // Aprovada de saída: quem aprova é ela mesma, e nascer pendente trancaria o
  // operador para fora do próprio painel.
  await db.query(
    "INSERT INTO users (id, email, password_hash, aprovado) VALUES ($1, $2, $3, true)",
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

    var result = await db.query(
      "SELECT id, password_hash, falhas, travado_ate, aprovado FROM users WHERE email = $1",
      [email]
    );
    // Mesma mensagem pra email inexistente e senha errada — dizer qual dos dois
    // errou permite a quem tenta invadir descobrir emails cadastrados um a um.
    var invalido = { error: "invalid_credentials", message: "Email ou senha incorretos." };
    if (!result.rows.length) return res.status(401).json(invalido);

    var user = result.rows[0];

    // A conta trava por alguns minutos depois de erros seguidos. Testar senha
    // deixa de ser barato: a espera cresce a cada rodada, e um ataque que fazia
    // milhares de tentativas por minuto passa a fazer cinco.
    if (user.travado_ate && new Date(user.travado_ate) > new Date()) {
      var faltam = Math.ceil((new Date(user.travado_ate) - new Date()) / 60000);
      return res.status(429).json({
        error: "muitas_tentativas",
        message: "Muitas tentativas seguidas. Tente de novo em " + faltam +
          (faltam === 1 ? " minuto." : " minutos."),
      });
    }

    if (!auth.verifyPassword(password, user.password_hash)) {
      var falhas = (user.falhas || 0) + 1;
      // Até a quinta, nada muda; a partir daí a espera dobra a cada erro, com
      // teto de 1 hora. Quem erra a própria senha uma ou duas vezes não sente.
      var minutos = falhas < 5 ? 0 : Math.min(60, Math.pow(2, falhas - 5));
      await db.query(
        "UPDATE users SET falhas = $1, travado_ate = $2 WHERE id = $3",
        [falhas, minutos ? new Date(Date.now() + minutos * 60000) : null, user.id]
      );
      return res.status(401).json(invalido);
    }

    // Acertou: o contador zera, senão um erro antigo ainda penalizaria depois.
    if (user.falhas) {
      await db.query("UPDATE users SET falhas = 0, travado_ate = NULL WHERE id = $1", [user.id]);
    }

    // A aprovação é conferida só depois da senha. Antes dela, a resposta
    // distinguiria email cadastrado de email inexistente e entregaria a lista
    // de clientes a quem quisesse descobri-la.
    if (user.aprovado === false) {
      return res.status(403).json({
        error: "aguardando_aprovacao",
        message: "Sua conta ainda não foi liberada. Você recebe um aviso assim que for.",
      });
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
