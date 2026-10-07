// O agente do WhatsApp: recebe o texto (ou a foto) de um cliente já conectado
// e devolve a resposta. Sem IA, por escolha: entende frases no formato do
// assistente do app ("gastei 45 no mercado") e alguns comandos fixos.
//
// O leitor de frases é o mesmo do app (quickParse em contas-em-dia.html),
// portado para cá. Mantenha os dois iguais: o lançamento feito pelo WhatsApp
// precisa sair idêntico ao feito pela tela.
const crypto = require("crypto");
const db = require("./_db");

var CATEGORIAS = {
  moradia: "Moradia", alimentacao: "Alimentação", transporte: "Transporte", saude: "Saúde",
  educacao: "Educação", lazer: "Lazer", assinaturas: "Assinaturas", compras: "Compras", outros_desp: "Outros",
  salario: "Salário", freelance: "Freelance / PJ", investimentos: "Investimentos", outros_rec: "Outros",
};
var EXPENSE_KEYWORDS = {
  moradia: ["aluguel", "condomínio", "condominio", "iptu", "conta de luz", "luz", "energia", "água", "agua", "internet", "gás", "gas"],
  alimentacao: ["mercado", "supermercado", "feira", "padaria", "restaurante", "lanche", "ifood", "almoço", "almoco", "jantar"],
  transporte: ["uber", "99", "gasolina", "combustível", "combustivel", "ônibus", "onibus", "metrô", "metro", "estacionamento", "pedágio", "pedagio"],
  saude: ["farmácia", "farmacia", "remédio", "remedio", "médico", "medico", "consulta", "plano de saúde", "academia", "dentista"],
  educacao: ["curso", "escola", "faculdade", "livro", "mensalidade"],
  lazer: ["cinema", "bar", "show", "viagem", "balada", "passeio"],
  assinaturas: ["netflix", "spotify", "assinatura", "amazon prime", "hbo", "disney"],
  compras: ["loja", "roupa", "sapato", "shopping", "presente"],
};
var INCOME_KEYWORDS = {
  salario: ["salário", "salario", "holerite", "pagamento do mês", "pagamento do mes"],
  freelance: ["freela", "freelance", "pj", "bico", "projeto"],
};
var MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// O servidor roda em UTC; "hoje" e "ontem" são os do cliente, no Brasil.
function hojeBR() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
}
function isoParaData(iso) { var p = iso.split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function toISODate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function addMonthsISO(iso, n) {
  var p = iso.split("-");
  var alvo = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1);
  var ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(Number(p[2]), ultimoDia));
  return toISODate(alvo);
}
function dividirParcelas(total, n) {
  var centavos = Math.round(total * 100);
  var base = Math.floor(centavos / n);
  var sobra = centavos - base * n;
  var valores = [];
  for (var i = 0; i < n; i++) valores.push((base + (i === 0 ? sobra : 0)) / 100);
  return valores;
}
function brl(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function dataCurta(iso) { var p = iso.split("-"); return p[2] + "/" + p[1]; }
function semAcento(s) { return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }

// Palavra inteira: com indexOf, o "gas" de Moradia casava dentro de "GASTEI" e
// quase todo gasto ia parar em Moradia.
function temPalavra(lower, palavra) {
  var i = lower.indexOf(palavra);
  while (i !== -1) {
    var antes = lower.charAt(i - 1), depois = lower.charAt(i + palavra.length);
    if (!/[a-z0-9à-ÿ]/.test(antes) && !/[a-z0-9à-ÿ]/.test(depois)) return true;
    i = lower.indexOf(palavra, i + 1);
  }
  return false;
}
function guessCategory(lower, dict, fallback) {
  for (var key in dict) {
    for (var i = 0; i < dict[key].length; i++) if (temPalavra(lower, dict[key][i])) return key;
  }
  return fallback;
}
function cleanDesc(text) {
  return text
    .replace(/^\s*(gastei|paguei|comprei|recebi|ganhei|caiu|entrou|investi|apliquei|guardei|poupei|separei|reservei|aportei)\s*/i, "")
    .replace(/r\$\s*/ig, "")
    .replace(/\b\d[\d.,]*\s*(mil|k)?\b/i, "")
    .replace(/\b(reais|real|conto|contos|pila)\b/ig, "")
    .replace(/^\s*(de|do|da|em|no|na|com|pra|para)\s+/i, "")
    .replace(/\s+(de|do|da|em|no|na|com|pra|para)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function parseWhen(lower) {
  var d = isoParaData(hojeBR());
  if (/\banteontem\b/.test(lower)) { d.setDate(d.getDate() - 2); return { date: toISODate(d), match: "anteontem" }; }
  if (/\bontem\b/.test(lower)) { d.setDate(d.getDate() - 1); return { date: toISODate(d), match: "ontem" }; }
  if (/\bhoje\b/.test(lower)) return { date: toISODate(d), match: "hoje" };
  var m = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    var dia = parseInt(m[1], 10), mes = parseInt(m[2], 10);
    var ano = m[3] ? parseInt(m[3], 10) : d.getFullYear();
    if (ano < 100) ano += 2000;
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) return { date: toISODate(new Date(ano, mes - 1, dia)), match: m[0] };
  }
  m = lower.match(/\bdia\s+(\d{1,2})\b/);
  if (m) {
    var dd = parseInt(m[1], 10);
    if (dd >= 1 && dd <= 31) {
      var alvo = new Date(d.getFullYear(), d.getMonth(), dd);
      if (alvo > d) alvo = new Date(d.getFullYear(), d.getMonth() - 1, dd);
      return { date: toISODate(alvo), match: m[0] };
    }
  }
  return null;
}
var AMOUNT_RE = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+\.\d{1,2}|\d+)\s*(mil|k)?/i;
function parseSpokenAmount(text) {
  var m = text.match(AMOUNT_RE);
  if (!m) return null;
  var raw = m[1], normalizado;
  if (/^\d{1,3}(\.\d{3})+/.test(raw)) normalizado = raw.replace(/\./g, "").replace(",", ".");
  else if (raw.indexOf(",") !== -1) normalizado = raw.replace(",", ".");
  else normalizado = raw;
  var valor = parseFloat(normalizado);
  if (isNaN(valor)) return null;
  if (m[2]) valor *= 1000;
  return { value: valor, match: m[0] };
}
function stripOnce(original, lowerHaystack, needle) {
  var i = lowerHaystack.indexOf(needle);
  if (i === -1) return original;
  return original.slice(0, i) + " " + original.slice(i + needle.length);
}

// Igual ao quickParse do app, mais duas coisas que no app têm campo próprio:
// parcelas ("em 3x", "em 3 vezes") e cartão (nome de um cartão do cliente).
function lerLancamento(text, cartoes) {
  var lower = text.toLowerCase();
  var parcelas = 1;
  var mp = lower.match(/\bem\s+(\d{1,2})\s*(?:x|vezes|parcelas)\b|\b(\d{1,2})\s*x\b/);
  if (mp) {
    parcelas = Math.max(1, Math.min(60, parseInt(mp[1] || mp[2], 10)));
    text = stripOnce(text, lower, mp[0]);
    lower = text.toLowerCase();
  }
  var when = parseWhen(lower);
  var semData = when ? stripOnce(lower, lower, when.match) : lower;
  var textoSemData = when ? stripOnce(text, lower, when.match) : text;
  var amount = parseSpokenAmount(semData);
  if (!amount || amount.value <= 0) return null;

  if (/dividendo|provento|\b(guardei|poupei|separei|reservei|aportei|investi|apliquei)\b/.test(lower)) {
    return { naoSuportado: "Investimentos, metas e dividendos ainda são só pelo app. Por aqui eu lanço gastos e entradas." };
  }

  var cartao = null;
  (cartoes || []).forEach(function (c) {
    var nome = String(c.nome || "").toLowerCase().trim();
    if (!cartao && nome.length >= 3 && lower.indexOf(nome) !== -1) {
      cartao = c;
      textoSemData = stripOnce(textoSemData, textoSemData.toLowerCase(), nome);
    }
  });

  var isIncome = /\b(recebi|ganhei|entrou|sal[aá]rio|reembolso)\b/.test(lower);
  var desc = cleanDesc(textoSemData.replace(/\b(no|na|do|da|com o|com a)\s*$/i, "")) || (isIncome ? "Receita" : "Despesa");
  return {
    desc: desc.slice(0, 80),
    amount: amount.value,
    type: isIncome ? "receita" : "despesa",
    category: guessCategory(lower, isIncome ? INCOME_KEYWORDS : EXPENSE_KEYWORDS, isIncome ? "outros_rec" : "outros_desp"),
    date: when ? when.date : hojeBR(),
    parcelas: isIncome ? 1 : parcelas,
    cartao: cartao,
  };
}

// ---------- Banco ----------
async function listar(userId, kind) {
  var r = await db.query(
    "SELECT id, data - 'comprovante' AS data, created_at FROM records WHERE user_id = $1 AND kind = $2 ORDER BY created_at ASC",
    [userId, kind]
  );
  return r.rows.map(function (x) { return Object.assign({ id: x.id, _criado: x.created_at }, x.data); });
}
async function inserir(userId, tx) {
  var id = crypto.randomUUID();
  await db.query("INSERT INTO records (id, user_id, kind, data) VALUES ($1, $2, 'transaction', $3)", [id, userId, JSON.stringify(tx)]);
  return id;
}

async function lancar(user, l, comprovante) {
  var agora = new Date().toISOString();
  var ids = [];
  if (l.parcelas > 1) {
    var grupo = "p" + Date.now() + Math.random().toString(36).slice(2, 7);
    var valores = dividirParcelas(l.amount, l.parcelas);
    for (var i = 0; i < valores.length; i++) {
      var tx = {
        desc: l.desc, amount: valores[i], type: l.type, category: l.category, date: addMonthsISO(l.date, i),
        paid: i === 0, parcela: { n: i + 1, de: l.parcelas, grupo: grupo },
        cartaoId: l.cartao ? l.cartao.id : null, createdAt: agora, origem: "whatsapp",
      };
      if (i === 0 && comprovante) tx.comprovante = comprovante;
      ids.push(await inserir(user.id, tx));
    }
  } else {
    // Igual ao app: no crédito a compra nasce em aberto (ocupa o limite até a
    // fatura ser paga); à vista ou no débito, já saiu da conta.
    var noCredito = !!(l.cartao && l.cartao.tipo !== "debito");
    var um = {
      desc: l.desc, amount: l.amount, type: l.type, category: l.category, date: l.date, paid: !noCredito,
      cartaoId: l.cartao ? l.cartao.id : null, createdAt: agora, origem: "whatsapp",
    };
    if (comprovante) um.comprovante = comprovante;
    ids.push(await inserir(user.id, um));
  }
  // Guarda o que acabou de entrar, para o "desfazer" saber o que apagar.
  await db.query("UPDATE users SET wa_ultimos = $1 WHERE id = $2", [JSON.stringify(ids), user.id]);

  var quando = l.date === hojeBR() ? "hoje" : dataCurta(l.date);
  var linha = (l.type === "receita" ? "✅ Entrada lançada: *" : "✅ Saída lançada: *") + l.desc + "* — " + brl(l.amount);
  if (l.parcelas > 1) linha += " em " + l.parcelas + "x de " + brl(dividirParcelas(l.amount, l.parcelas)[1]);
  linha += "\n" + CATEGORIAS[l.category] + " · " + quando + (l.cartao ? " · cartão " + l.cartao.nome : "");
  if (comprovante) linha += "\n📎 Comprovante anexado";
  return linha + "\n\nErrei? Responda *desfazer*.";
}

// ---------- Comandos ----------
var AJUDA =
  "Oi! Sou o assistente do *Wonner Sols* 👋\n\n" +
  "*Para lançar*, escreva como falaria:\n" +
  "• gastei 45 no mercado\n• paguei 120 de luz ontem\n• comprei 600 em 3x no nubank\n• recebi 3000 de salário\n" +
  "• mande a *foto da nota* e depois o valor\n\n" +
  "*Para consultar*:\n• *resumo* — o mês atual (ou *resumo setembro*)\n• *parcelas* — compras parceladas em aberto\n" +
  "• *últimos* — os 5 lançamentos mais recentes\n• *desfazer* — apaga o último lançamento feito por aqui";

async function resumo(user, textoNorm) {
  var hoje = hojeBR();
  var ano = Number(hoje.slice(0, 4)), mes = Number(hoje.slice(5, 7));
  MESES.forEach(function (nome, i) {
    if (textoNorm.indexOf(semAcento(nome)) !== -1) {
      if (i + 1 > mes) ano -= 1; // "resumo dezembro" em outubro = dezembro passado
      mes = i + 1;
    }
  });
  var chave = ano + "-" + String(mes).padStart(2, "0");
  var txs = (await listar(user.id, "transaction")).filter(function (t) { return String(t.date).slice(0, 7) === chave; });
  var rec = 0, desp = 0, pend = 0, porCat = {};
  txs.forEach(function (t) {
    var v = Number(t.amount) || 0;
    if (t.type === "receita") rec += v;
    else {
      desp += v;
      porCat[t.category] = (porCat[t.category] || 0) + v;
      if (t.paid === false) pend += v;
    }
  });
  var top = Object.keys(porCat).sort(function (a, b) { return porCat[b] - porCat[a]; }).slice(0, 3);
  var texto = "📊 *" + MESES[mes - 1][0].toUpperCase() + MESES[mes - 1].slice(1) + " de " + ano + "*\n\n" +
    "Entradas: " + brl(rec) + "\nSaídas: " + brl(desp) + "\n*Saldo: " + brl(rec - desp) + "*";
  if (pend) texto += "\nA pagar ainda: " + brl(pend);
  if (top.length) texto += "\n\nOnde mais gastou:\n" + top.map(function (k) { return "• " + (CATEGORIAS[k] || k) + ": " + brl(porCat[k]); }).join("\n");
  if (!txs.length) texto += "\n\nNenhum lançamento neste mês ainda.";
  return texto;
}

async function parcelas(user) {
  var grupos = {};
  (await listar(user.id, "transaction")).forEach(function (t) {
    if (!t.parcela || t.paid !== false) return;
    var g = grupos[t.parcela.grupo] || (grupos[t.parcela.grupo] = { desc: t.desc, falta: 0, restantes: 0, de: t.parcela.de, proxima: null });
    g.falta += Number(t.amount) || 0;
    g.restantes += 1;
    if (!g.proxima || t.date < g.proxima) g.proxima = t.date;
  });
  var lista = Object.keys(grupos).map(function (k) { return grupos[k]; });
  if (!lista.length) return "Nenhuma compra parcelada em aberto. 🎉";
  return "💳 *Parcelas em aberto*\n\n" + lista.map(function (g) {
    return "• *" + g.desc + "*: falta " + brl(g.falta) + " (" + g.restantes + " de " + g.de + "), próxima " + dataCurta(g.proxima);
  }).join("\n");
}

// Os últimos lançados (não os de data mais adiante): uma compra parcelada
// aparece uma vez, pela 1ª parcela, em vez de as futuras ocuparem a lista.
async function ultimos(user) {
  var txs = (await listar(user.id, "transaction")).filter(function (t) {
    return !t.parcela || t.parcela.n === 1;
  }).sort(function (a, b) { return a._criado < b._criado ? 1 : -1; }).slice(0, 5);
  if (!txs.length) return "Você ainda não tem lançamentos.";
  return "🧾 *Últimos lançamentos*\n\n" + txs.map(function (t) {
    return (t.type === "receita" ? "➕ " : "➖ ") + dataCurta(t.date) + " · " + t.desc + " — " + brl(t.amount) +
      (t.parcela ? " (" + t.parcela.de + "x)" : "");
  }).join("\n");
}

async function desfazer(user) {
  var ids = Array.isArray(user.wa_ultimos) ? user.wa_ultimos : [];
  if (!ids.length) return "Não há nada recente feito por aqui para desfazer.";
  var r = await db.query(
    "DELETE FROM records WHERE user_id = $1 AND kind = 'transaction' AND id = ANY($2::uuid[]) RETURNING data->>'desc' AS d",
    [user.id, ids]
  );
  await db.query("UPDATE users SET wa_ultimos = NULL WHERE id = $1", [user.id]);
  if (!r.rows.length) return "Esse lançamento já tinha sido apagado.";
  return "↩️ Desfeito: *" + r.rows[0].d + "*" + (r.rows.length > 1 ? " (" + r.rows.length + " parcelas)" : "") + ".";
}

// ---------- Entrada principal ----------
// user: linha de users (id, email, wa_pendente, wa_ultimos). msg: { texto } ou
// { foto: {dados,tipo}, legenda } ou { fotoGrande: true, legenda }.
async function responder(user, msg) {
  var cartoes = await listar(user.id, "card");

  // Foto/PDF: com valor na legenda já lança; sem, guarda e pergunta o valor.
  if (msg.foto || msg.fotoGrande) {
    var comp = msg.foto ? { dados: msg.foto.dados, tipo: msg.foto.tipo, nome: msg.foto.tipo === "application/pdf" ? "comprovante.pdf" : "comprovante.jpg" } : null;
    var daLegenda = msg.legenda ? lerLancamento(msg.legenda, cartoes) : null;
    if (daLegenda && !daLegenda.naoSuportado) {
      return (await lancar(user, daLegenda, comp)) + (msg.fotoGrande ? "\n\n(A foto era grande demais para guardar; lancei sem ela.)" : "");
    }
    if (!comp) return "Essa foto é grande demais para eu guardar. Me manda só o valor e o que foi (ex.: *87,90 mercado*).";
    await db.query("UPDATE users SET wa_pendente = $1 WHERE id = $2", [JSON.stringify({ comprovante: comp, em: new Date().toISOString() }), user.id]);
    return "📎 Recebi o comprovante! Qual o valor e o que foi?\nEx.: *87,90 mercado* — ou *cancelar*.";
  }

  var texto = String(msg.texto || "").trim();
  var norm = semAcento(texto);
  var pendente = user.wa_pendente && user.wa_pendente.comprovante ? user.wa_pendente : null;

  if (pendente && /^(cancelar|cancela|nao|deixa)\b/.test(norm)) {
    await db.query("UPDATE users SET wa_pendente = NULL WHERE id = $1", [user.id]);
    return "Ok, descartei o comprovante.";
  }
  if (/^(oi|ola|ajuda|menu|comandos|help|bom dia|boa tarde|boa noite)\b/.test(norm) && !/\d/.test(norm)) return AJUDA;
  if (/^(resumo|saldo|extrato|quanto gastei)/.test(norm)) return resumo(user, norm);
  if (/^parcela/.test(norm)) return parcelas(user);
  if (/^(ultimos|ultimas|lancamentos|historico)\b/.test(norm)) return ultimos(user);
  if (/^(desfazer|desfaz|apagar ultimo|apaga ultimo|errei)\b/.test(norm)) return desfazer(user);

  var l = lerLancamento(texto, cartoes);
  if (l && l.naoSuportado) return l.naoSuportado;
  if (l) {
    var comprovante = pendente ? pendente.comprovante : null;
    var resposta = await lancar(user, l, comprovante);
    if (pendente) await db.query("UPDATE users SET wa_pendente = NULL WHERE id = $1", [user.id]);
    return resposta;
  }
  if (pendente) return "Ainda preciso do valor do comprovante que você mandou. Ex.: *87,90 mercado* — ou *cancelar*.";
  return "Não entendi 🤔 Para lançar, inclua o valor (ex.: *gastei 45 no mercado*). Mande *ajuda* para ver tudo que eu faço.";
}

module.exports = { responder, lerLancamento, AJUDA, brl, dataCurta };
