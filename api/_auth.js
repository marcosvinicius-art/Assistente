// Senha e sessão, só com o módulo "crypto" já embutido no Node — nenhuma biblioteca
// de terceiros pra isso, então não há dependência nova pra confiar ou atualizar.
const crypto = require("crypto");

const SESSION_COOKIE = "wonner_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias, em segundos

function getSecret() {
  var s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    // Sem isso, qualquer um forjaria uma sessão de qualquer cliente — por isso
    // falha alto e claro aqui, em vez de aceitar um segredo fraco ou ausente.
    throw new Error(
      "SESSION_SECRET não configurada (ou curta demais). Defina uma string aleatória " +
      "longa nas variáveis de ambiente do projeto na Vercel."
    );
  }
  return s;
}

// ---------- Senha ----------
// scrypt: função de hash de senha recomendada pela própria documentação do Node
// quando não se quer trazer bcrypt/argon2 como dependência externa.
function hashPassword(password) {
  var salt = crypto.randomBytes(16);
  var hash = crypto.scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  var parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  var salt = Buffer.from(parts[0], "hex");
  var hashGuardado = Buffer.from(parts[1], "hex");
  var hashTentativa = crypto.scryptSync(password, salt, 64);
  if (hashTentativa.length !== hashGuardado.length) return false;
  // timingSafeEqual: compara em tempo constante, pra não vazar a senha por
  // quanto tempo a comparação demorou (timing attack).
  return crypto.timingSafeEqual(hashTentativa, hashGuardado);
}

// ---------- Admin ----------
// A conta do admin não mora na tabela "users": é uma única conta fixa, definida
// pelas variáveis de ambiente ADMIN_EMAIL/ADMIN_PASSWORD na Vercel — nunca em
// arquivo nenhum do projeto. SHA-256 antes de comparar existe só pra igualar o
// tamanho dos dois lados (timingSafeEqual exige buffers do mesmo tamanho); a
// senha do admin não fica com hash fraco por causa disso — o comparador em si
// é que precisa de tamanho fixo, e SHA-256 aqui serve só a esse propósito.
function isAdminEmail(email) {
  var esperado = process.env.ADMIN_EMAIL;
  return !!esperado && String(email || "").toLowerCase() === esperado.toLowerCase();
}

function verifyAdminPassword(password) {
  var esperado = process.env.ADMIN_PASSWORD;
  if (!esperado) return false;
  var a = crypto.createHash("sha256").update(String(password || "")).digest();
  var b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Sessão (token assinado, guardado num cookie) ----------
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payloadB64) {
  return base64url(crypto.createHmac("sha256", getSecret()).update(payloadB64).digest());
}

function createSessionToken(userId, isAdmin) {
  var dados = { uid: userId, exp: Date.now() + SESSION_MAX_AGE * 1000 };
  if (isAdmin) dados.admin = true;
  var payloadB64 = base64url(Buffer.from(JSON.stringify(dados), "utf8"));
  return payloadB64 + "." + sign(payloadB64);
}

function verifySessionToken(token) {
  if (!token || token.indexOf(".") === -1) return null;
  var partes = token.split(".");
  var payloadB64 = partes[0], assinatura = partes[1];
  var esperada = sign(payloadB64);
  // Mesmo motivo do timingSafeEqual acima: comparar assinatura em tempo constante.
  var a = Buffer.from(assinatura || "");
  var b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    var payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.uid || !payload.exp || payload.exp < Date.now()) return null;
  return { uid: payload.uid, isAdmin: !!payload.admin };
}

// ---------- Cookie ----------
function parseCookies(req) {
  var header = req.headers.cookie || "";
  var out = {};
  header.split(";").forEach(function (par) {
    var i = par.indexOf("=");
    if (i === -1) return;
    out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  var token = parseCookies(req)[SESSION_COOKIE];
  return verifySessionToken(token);
}

function setSessionCookie(res, token) {
  // httpOnly: JavaScript da página nunca lê o cookie (se alguém injetar um script
  // malicioso, não rouba a sessão). Secure: só trafega em HTTPS. SameSite=Lax:
  // não vai em requisições disparadas por OUTROS sites (mitiga CSRF).
  res.setHeader(
    "Set-Cookie",
    SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" + SESSION_MAX_AGE +
    "; HttpOnly; Secure; SameSite=Lax"
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
}

// ---------- Validação de entrada ----------
function validEmail(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

module.exports = {
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  isAdminEmail: isAdminEmail,
  verifyAdminPassword: verifyAdminPassword,
  createSessionToken: createSessionToken,
  getSession: getSession,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  validEmail: validEmail,
  validPassword: validPassword,
};
