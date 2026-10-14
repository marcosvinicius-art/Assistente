// Gerenciamento de chaves VAPID e envio de push notifications.
// As chaves são geradas automaticamente na primeira vez e salvas no banco;
// não precisa configurar nada na Vercel — funciona sozinho.
const crypto = require("crypto");
const db = require("./_db");

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Gera um par de chaves VAPID (P-256) usando só o crypto do Node.
async function gerarChaves() {
  var { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  var privJwk = privateKey.export({ format: "jwk" });
  var pubJwk = publicKey.export({ format: "jwk" });
  var x = Buffer.from(pubJwk.x, "base64");
  var y = Buffer.from(pubJwk.y, "base64");
  var pubUncompressed = Buffer.concat([Buffer.from([4]), x, y]);
  return {
    publicKey: base64url(pubUncompressed),
    privateKey: privJwk.d,
  };
}

var _chaves = null;

async function obterChaves() {
  if (_chaves) return _chaves;
  var cfg = await db.query("SELECT valor FROM config WHERE chave = 'vapid'");
  if (cfg.rows.length) { _chaves = cfg.rows[0].valor; return _chaves; }
  var novas = await gerarChaves();
  await db.query(
    "INSERT INTO config (chave, valor, atualizado_em) VALUES ('vapid', $1, now()) ON CONFLICT (chave) DO NOTHING",
    [novas]
  );
  _chaves = novas;
  return _chaves;
}

// Envia uma push notification para uma subscription salva.
// Retorna string de motivo em caso de falha não crítica.
async function enviarPush(subscription, payload) {
  if (!subscription || !subscription.endpoint) return "sem subscription";
  var chaves = await obterChaves();
  var webpush = require("web-push");
  webpush.setVapidDetails(
    "mailto:marcos.vinicius@useebrasil.com.br",
    chaves.publicKey,
    chaves.privateKey
  );
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

module.exports = { obterChaves, enviarPush };
