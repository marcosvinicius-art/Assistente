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
  budgets: "budget",     // orçamento por categoria
  recurring: "recurring", // contas fixas que se repetem todo mês
  paineis: "painel",      // painéis salvos do assistente (guardam só a pergunta)
  vendas: "venda",        // vendas (custo x preço) — só contas liberadas pelo admin
  estoque: "aparelho",    // Wonner Loja: aparelhos em estoque (IMEI, custo, troca)
  loja: "loja",           // Wonner Loja: configuração da loja (taxas, recibo) — um registro só
  caixa: "caixa",         // Wonner Loja: lançamentos do caixa da loja
};

// Tipos da Wonner Loja: só para contas com a loja liberada (coluna "vendas").
var KINDS_DA_LOJA = ["venda", "aparelho", "loja", "caixa"];

var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// O comprovante (foto ou PDF de até ~250 KB) mora no próprio lançamento, mas
// nunca vai na lista: com o tempo seriam megabytes baixados a cada abertura do
// app. A lista leva só "temComprovante"; a imagem vem por GET ?id= quando a
// pessoa toca para ver.
function semComprovante(registro) {
  if (!registro || !registro.comprovante) return registro;
  var leve = Object.assign({}, registro, { temComprovante: true });
  delete leve.comprovante;
  return leve;
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
    if (!session.isAdmin && (await db.clienteEmManutencao(userId))) {
      return res.status(503).json({
        error: "manutencao",
        message: "O site está em manutenção. Volte daqui a pouco — seus dados estão guardados.",
      });
    }

    // A loja (e a aba Vendas) é liberada conta a conta pelo admin; esconder na
    // tela não basta, então a trava de verdade é esta.
    if (KINDS_DA_LOJA.indexOf(kind) >= 0 && !session.isAdmin) {
      var lib = await db.query("SELECT vendas FROM users WHERE id = $1", [userId]);
      if (!lib.rows.length || !lib.rows[0].vendas) {
        return res.status(403).json({ error: "vendas_bloqueado", message: "A aba Vendas não está liberada para sua conta." });
      }
    }

    // Sem assinatura (teste acabou, pagamento não feito), o cliente continua
    // VENDO tudo o que já lançou — só não grava. Bloquear a leitura faria os
    // dados parecerem perdidos, e quem vê o que tem é quem volta a assinar.
    if (req.method !== "GET" && !session.isAdmin && !(await db.situacaoDoUsuario(userId)).liberado) {
      return res.status(402).json({
        error: "assinatura",
        message: "Seu período grátis acabou. Assine para continuar lançando — seus dados estão todos aqui.",
      });
    }

    if (req.method === "GET" && req.query.id) {
      var um = await db.query(
        "SELECT id, data FROM records WHERE id = $1 AND user_id = $2 AND kind = $3",
        [req.query.id, userId, kind]
      );
      if (!um.rows.length) return res.status(404).json({ error: "not_found" });
      return res.status(200).json(rowToRecord(um.rows[0]));
    }

    if (req.method === "GET") {
      // O corte do comprovante é feito no próprio banco, para a imagem nem
      // trafegar até aqui.
      var lista = await db.query(
        "SELECT id, data - 'comprovante' AS data, (data ? 'comprovante') AS tem_comprovante " +
        "FROM records WHERE user_id = $1 AND kind = $2 ORDER BY created_at ASC",
        [userId, kind]
      );
      return res.status(200).json(lista.rows.map(function (row) {
        var r = rowToRecord(row);
        if (row.tem_comprovante) r.temComprovante = true;
        return r;
      }));
    }

    if (req.method === "POST") {
      var novo = Object.assign({}, req.body || {});
      if (!cabeNoRegistro(novo)) {
        return res.status(413).json({ error: "muito_grande", message: "Esse registro é grande demais." });
      }
      // A Wonner Loja liga registros entre si (venda → aparelho, caixa → venda)
      // e por isso cria o id no navegador. Só UUID é aceito, e um id que já
      // existe — desta conta ou de outra — é recusado em vez de sobrescrito.
      var id = UUID.test(novo.id) ? String(novo.id).toLowerCase() : crypto.randomUUID();
      delete novo.id;
      var inserido = await db.query(
        "INSERT INTO records (id, user_id, kind, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
        [id, userId, kind, JSON.stringify(novo)]
      );
      if (!inserido.rowCount) return res.status(409).json({ error: "id_em_uso", message: "Esse registro já existe." });
      return res.status(200).json(semComprovante(Object.assign({ id: id }, novo)));
    }

    var alvoId = req.query.id;
    if (!alvoId) return res.status(400).json({ error: "missing_id" });
    // Id fora do formato faria o Postgres responder com erro (500); é só "não existe".
    if (!UUID.test(alvoId)) return res.status(404).json({ error: "not_found" });

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
      return res.status(200).json(semComprovante(Object.assign({ id: alvoId }, mesclado)));
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
