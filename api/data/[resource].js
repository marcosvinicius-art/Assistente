// CRUD genérico pros três tipos de dado do app — lançamentos, metas e investimentos
// têm o mesmo ciclo de vida (listar, criar, atualizar, apagar), só o formato de
// dentro muda, e esse formato é decidido pelo próprio front-end, não por aqui.
const crypto = require("crypto");
const db = require("../_db");
const auth = require("../_auth");

var KIND_BY_RESOURCE = {
  transactions: "transaction",
  goals: "goal",
  investments: "investment",
  cards: "card",
};

// O conteúdo de cada registro é decidido pelo front-end, então este arquivo não
// sabe quais campos existem — mas sabe que nenhum registro legítimo é grande.
// Sem teto, uma conta qualquer encheria o banco com um único POST, e a foto de
// cartão (data URL) é o campo que mais cresce.
var LIMITE_BYTES = 300 * 1024;

function cabeNoRegistro(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj || {}), "utf8") <= LIMITE_BYTES;
  } catch (e) {
    // Referência circular e afins: se nem serializa, não entra no banco.
    return false;
  }
}

function rowToRecord(row) {
  // O front-end usa objetos simples com "id" no nível raiz (ex: {id, desc, amount});
  // no banco o conteúdo fica dentro de "data", então remonta aqui antes de responder.
  return Object.assign({ id: row.id }, row.data);
}

module.exports = async function handler(req, res) {
  var kind = KIND_BY_RESOURCE[req.query.resource];
  if (!kind) return res.status(404).json({ error: "not_found" });

  var session = auth.getSession(req);
  if (!session) return res.status(401).json({ error: "not_authenticated" });
  var userId = session.uid;

  try {
    // Quem já estava logado também para: a sessão dura 30 dias, e barrar só o
    // login deixaria essas pessoas gravando no meio da manutenção.
    if (!session.isAdmin && (await db.lerConfig()).manutencao) {
      return res.status(503).json({
        error: "manutencao",
        message: "O site está em manutenção. Volte daqui a pouco — seus dados estão guardados.",
      });
    }

    if (req.method === "GET") {
      var lista = await db.query(
        "SELECT id, data FROM records WHERE user_id = $1 AND kind = $2 ORDER BY created_at ASC",
        [userId, kind]
      );
      return res.status(200).json(lista.rows.map(rowToRecord));
    }

    if (req.method === "POST") {
      var novo = req.body || {};
      if (!cabeNoRegistro(novo)) {
        return res.status(413).json({ error: "muito_grande", message: "Esse registro é grande demais." });
      }
      var id = crypto.randomUUID();
      await db.query(
        "INSERT INTO records (id, user_id, kind, data) VALUES ($1, $2, $3, $4)",
        [id, userId, kind, JSON.stringify(novo)]
      );
      return res.status(200).json(Object.assign({ id: id }, novo));
    }

    var alvoId = req.query.id;
    if (!alvoId) return res.status(400).json({ error: "missing_id" });

    if (req.method === "PATCH") {
      var patch = req.body || {};
      // user_id na cláusula WHERE (não só o id) é o que impede um cliente de editar
      // o registro de outro só adivinhando o id.
      var atual = await db.query(
        "SELECT data FROM records WHERE id = $1 AND user_id = $2 AND kind = $3",
        [alvoId, userId, kind]
      );
      if (!atual.rows.length) return res.status(404).json({ error: "not_found" });
      var mesclado = Object.assign({}, atual.rows[0].data, patch);
      // Conferido depois da mesclagem: um patch pequeno sobre um registro já
      // grande ainda estouraria o limite.
      if (!cabeNoRegistro(mesclado)) {
        return res.status(413).json({ error: "muito_grande", message: "Esse registro é grande demais." });
      }
      await db.query("UPDATE records SET data = $1 WHERE id = $2 AND user_id = $3", [
        JSON.stringify(mesclado), alvoId, userId,
      ]);
      return res.status(200).json(Object.assign({ id: alvoId }, mesclado));
    }

    if (req.method === "DELETE") {
      await db.query("DELETE FROM records WHERE id = $1 AND user_id = $2 AND kind = $3", [
        alvoId, userId, kind,
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("data/" + req.query.resource + " falhou:", e);
    return res.status(500).json({
      error: "server_error",
      message: db.mensagemDeFalha(e, "Não consegui salvar agora. Tenta de novo."),
    });
  }
};
