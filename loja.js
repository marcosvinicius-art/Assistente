/* Wonner Loja (base: CelGestor) — gestão de loja de celulares.
   Login e dados no servidor do Wonner Sols: /api/auth e /api/data/{estoque,vendas,caixa,loja}.
   Só entra quem tem a loja liberada pelo admin; quem barra de verdade é o servidor (403). */
'use strict';

const TERMOS_PADRAO = 'A garantia cobre defeitos de funcionamento do aparelho pelo prazo indicado neste recibo. ' +
  'Não cobre: quedas, trincas, contato com líquidos, oxidação, mau uso, aparelho aberto ou consertado por terceiros, ' +
  'nem acessórios. Para acionar a garantia, apresente este recibo e o aparelho com o mesmo IMEI.';

const DEFAULT_CONFIG = {
  loja: 'Minha Loja',
  documento: '',
  telefone: '',
  endereco: '',
  garantiaDias: 90,
  termos: TERMOS_PADRAO,
  diasAlerta: 30,
  // Taxas de exemplo (%) — ajuste para a sua maquininha em Configurações
  taxas: {
    pix: 0,
    dinheiro: 0,
    debito: 1.37,
    credito: [3.15, 5.39, 6.12, 6.85, 7.57, 8.28, 8.99, 9.69, 10.38, 11.06, 11.74, 12.4]
  }
};

const FORMAS = {
  pix: { nome: 'Pix', badge: 'b-green' },
  dinheiro: { nome: 'Dinheiro', badge: 'b-gray' },
  debito: { nome: 'Débito', badge: 'b-blue' },
  credito: { nome: 'Crédito', badge: 'b-purple' }
};

const CATEGORIAS_CAIXA = {
  entrada: ['Aporte', 'Outras entradas'],
  saida: ['Despesa', 'Retirada (pró-labore)', 'Outras saídas']
};

/* ---------- Estado ---------- */
const TABELAS = ['aparelhos', 'vendas', 'caixa'];
// Nome de cada tabela na API do Wonner Sols (/api/data/<recurso>).
const RECURSO = { aparelhos: 'estoque', vendas: 'vendas', caixa: 'caixa' };

let state = normalize(null);
let usuario = null;

function normalize(s) {
  s = s || {};
  const config = { ...structuredClone(DEFAULT_CONFIG), ...s.config };
  config.taxas = { ...DEFAULT_CONFIG.taxas, ...(s.config || {}).taxas };
  return { aparelhos: [], vendas: [], caixa: [], ...s, config };
}

function save() {
  return nuvem.enviar();
}

function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts).then(r => r.json().catch(() => null).then(d => {
    if (!r.ok) {
      const e = new Error((d && d.message) || 'Erro do servidor.');
      e.status = r.status; e.code = d && d.error;
      throw e;
    }
    return d;
  }));
}

/* ---------- Registros da primeira versão da Wonner Loja ---------- */
// Antes desta tela, a loja (e a aba Vendas do app) gravava com outros nomes de
// campo. Convertidos só na leitura: o banco fica como está até o registro ser editado.
const capitalizar = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

function migrarAparelho(a) {
  if (a.dataCompra) return a;
  return {
    ...a, marca: a.marca || '', dataCompra: a.entradaEm || todayISO(),
    status: a.status === 'vendido' ? 'vendido' : 'estoque',
    precoVenda: a.precoVenda ?? a.precoSugerido ?? 0, condicao: capitalizar(a.condicao)
  };
}

function migrarVenda(v) {
  if (v.cobrado != null) return v;
  const qtd = Math.max(1, Number(v.qtd) || 1);
  const cobrado = round2(qtd * (Number(v.preco) || 0));
  const taxaValor = Number(v.taxas) || 0;
  const custo = round2(qtd * (Number(v.custo) || 0));
  const parcelas = Math.max(1, Number(v.parcelas) || 1);
  const cli = v.cliente && typeof v.cliente === 'object' ? v.cliente : { nome: v.cliente };
  return {
    ...v, descricao: (v.produto || '') + (qtd > 1 ? ' ×' + qtd : ''),
    cliente: cli.nome || '', telefone: cli.telefone || v.telefone || '', cpf: cli.cpf || v.cpf || '',
    forma: FORMAS[v.pagamento] ? v.pagamento : parcelas > 1 ? 'credito' : 'pix', parcelas,
    preco: cobrado, cobrado, liquido: round2(cobrado - taxaValor), taxaValor, taxaPct: 0, jurosCliente: 0,
    parcelaValor: round2(cobrado / parcelas), custo, lucro: round2(cobrado - taxaValor - custo)
  };
}

/* ---------- Nuvem (servidor do Wonner Sols) ---------- */
// Mantém uma cópia do que já está no servidor e envia só o que mudou.
const nuvem = {
  enviado: {},
  fila: Promise.resolve(),
  status: 'salvo',
  lojaId: null,

  async baixar() {
    const [aparelhos, vendas, caixa, loja] = await Promise.all(
      ['estoque', 'vendas', 'caixa', 'loja'].map(r => api('GET', '/api/data/' + r)));
    const perfil = loja[0] || null;
    this.lojaId = perfil ? perfil.id : null;
    // A primeira versão guardava os dados do recibo soltos no registro, sem "config".
    const config = perfil && (perfil.config || {
      loja: perfil.nome, documento: perfil.documento, telefone: perfil.telefone,
      endereco: perfil.endereco, garantiaDias: perfil.garantiaDias, termos: perfil.termos
    });
    if (config) Object.keys(config).forEach(k => config[k] == null && delete config[k]);
    state = normalize({ config, aparelhos: aparelhos.map(migrarAparelho), vendas: vendas.map(migrarVenda), caixa });
    this.marcarEnviado();
  },

  marcarEnviado() {
    this.enviado = { config: JSON.stringify(state.config) };
    TABELAS.forEach(t => (this.enviado[t] = new Map(state[t].map(r => [r.id, JSON.stringify(r)]))));
  },

  enviar() {
    this.setStatus('salvando');
    this.fila = this.fila.then(() => this.enviarAgora()).then(
      () => this.setStatus('salvo'),
      e => {
        console.error(e);
        this.setStatus('erro');
        if (e && e.status === 402) toast('Seu período grátis acabou. Assine pela página inicial do Wonner Sols para continuar salvando.', 8000);
        else if (e && e.status === 403) toast('A Wonner Loja não está liberada para esta conta.', 8000);
        else toast('Erro ao salvar. Verifique a internet — tentaremos de novo na próxima alteração.');
      }
    );
    return this.fila;
  },

  async enviarAgora() {
    const cfg = JSON.stringify(state.config);
    if (cfg !== this.enviado.config) {
      if (this.lojaId) await api('PATCH', '/api/data/loja?id=' + this.lojaId, { config: state.config });
      else this.lojaId = (await api('POST', '/api/data/loja', { config: state.config })).id;
      this.enviado.config = cfg;
    }
    for (const t of TABELAS) {
      const url = '/api/data/' + RECURSO[t];
      const antes = this.enviado[t];
      // Cada registro confirmado entra logo em "antes": se a rede cair no meio,
      // a próxima alteração reenvia só o que faltou.
      for (const r of state[t]) {
        const json = JSON.stringify(r);
        if (antes.get(r.id) === json) continue;
        if (antes.has(r.id)) {
          const { id, ...dados } = r;
          await api('PATCH', url + '?id=' + encodeURIComponent(id), dados);
        } else {
          await api('POST', url, r);
        }
        antes.set(r.id, json);
      }
      const ids = new Set(state[t].map(r => r.id));
      for (const id of [...antes.keys()]) {
        if (ids.has(id)) continue;
        await api('DELETE', url + '?id=' + encodeURIComponent(id));
        antes.delete(id);
      }
    }
  },

  setStatus(s) {
    this.status = s;
    const el = $('#syncStatus');
    if (el) {
      el.className = 'sync ' + s;
      el.textContent = { salvando: 'Salvando…', salvo: 'Salvo na sua conta', erro: 'Erro ao salvar' }[s];
    }
  }
};

window.addEventListener('beforeunload', e => {
  if (nuvem.status === 'salvando') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- Utilitários ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
// UUID: é o único formato de id que o servidor aceita vindo do navegador.
const uid = () => crypto.randomUUID();
const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl = v => brlFmt.format(v || 0);
const pct = v => (isFinite(v) ? v : 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
const round2 = v => Math.round(v * 100) / 100;
const todayISO = () => new Date().toLocaleDateString('sv-SE');
const monthOf = iso => (iso || '').slice(0, 7);
const currentMonth = () => todayISO().slice(0, 7);
const fmtDate = iso => iso ? iso.split('-').reverse().join('/') : '—';
const num = v => parseFloat(String(v).replace(',', '.')) || 0;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function daysBetween(fromISO, toISO = todayISO()) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  return Math.max(0, Math.round((b - a) / 86400000));
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function nomeAparelho(a) {
  return [a.marca, a.modelo, a.armazenamento].filter(Boolean).join(' ');
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const digitos = s => String(s || '').replace(/\D/g, '');

// IMEI tem dígito verificador (Luhn): pega erro de digitação na hora.
function imeiValido(s) {
  if (!/^\d{15}$/.test(s)) return false;
  let soma = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(s[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    soma += d;
  }
  return soma % 10 === 0;
}

function avisoImei(imei, ignorarId) {
  const s = digitos(imei);
  if (!s) return '';
  if (s.length !== 15) return `IMEI tem 15 dígitos (este tem ${s.length}).`;
  if (!imeiValido(s)) return 'Esse IMEI não confere — verifique se digitou certo.';
  if (state.aparelhos.some(a => digitos(a.imei) === s && a.id !== ignorarId && a.status === 'estoque')) return 'Já existe um aparelho com esse IMEI no estoque.';
  return '';
}

function somaDias(iso, dias) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + (Number(dias) || 0));
  return d.toLocaleDateString('sv-SE');
}

function garantiaAte(v) {
  return v.garantiaDias ? somaDias(v.data, v.garantiaDias) : null;
}

function paradoBadge(dias) {
  const alerta = state.config.diasAlerta;
  const cls = dias >= alerta * 2 ? 'b-red' : dias >= alerta ? 'b-amber' : 'b-green';
  return `<span class="badge ${cls}">${dias} ${dias === 1 ? 'dia' : 'dias'}</span>`;
}

function formaBadge(v) {
  const f = FORMAS[v.forma] || { nome: v.forma, badge: 'b-gray' };
  const extra = v.forma === 'credito' ? ` ${v.parcelas}x` : '';
  return `<span class="badge ${f.badge}">${f.nome}${extra}</span>`;
}

/* ---------- Cálculos ---------- */
function taxaPara(forma, parcelas = 1) {
  const t = state.config.taxas;
  if (forma === 'credito') return num(t.credito[parcelas - 1] ?? t.credito[t.credito.length - 1]);
  return num(t[forma]);
}

// preco = valor à vista combinado. Se repassar, o cliente paga a taxa e você recebe o preço cheio.
function calcVenda({ preco, forma, parcelas = 1, repassar }) {
  const taxaPct = taxaPara(forma, parcelas);
  let cobrado, liquido;
  if (repassar && taxaPct > 0) {
    cobrado = preco / (1 - taxaPct / 100);
    liquido = preco;
  } else {
    cobrado = preco;
    liquido = preco * (1 - taxaPct / 100);
  }
  cobrado = round2(cobrado);
  liquido = round2(liquido);
  return {
    taxaPct,
    cobrado,
    liquido,
    taxaValor: round2(cobrado - liquido),
    jurosCliente: round2(cobrado - preco),
    parcelaValor: round2(cobrado / (forma === 'credito' ? parcelas : 1))
  };
}

function saldoCaixa() {
  return state.caixa.reduce((s, l) => s + (l.tipo === 'entrada' ? l.valor : -l.valor), 0);
}

function emEstoque() {
  return state.aparelhos.filter(a => a.status === 'estoque');
}

function resumoMes(ym) {
  const vendas = state.vendas.filter(v => monthOf(v.data) === ym);
  const fat = vendas.reduce((s, v) => s + v.cobrado, 0);
  const liquido = vendas.reduce((s, v) => s + v.liquido, 0);
  const cmv = vendas.reduce((s, v) => s + v.custo, 0);
  const lucro = vendas.reduce((s, v) => s + v.lucro, 0);
  const taxas = vendas.reduce((s, v) => s + v.taxaValor, 0);
  const juros = vendas.reduce((s, v) => s + v.jurosCliente, 0);
  const despesas = state.caixa
    .filter(l => l.tipo === 'saida' && l.categoria === 'Despesa' && monthOf(l.data) === ym)
    .reduce((s, l) => s + l.valor, 0);
  const compras = state.aparelhos
    .filter(a => monthOf(a.dataCompra) === ym)
    .reduce((s, a) => s + a.custo, 0);
  return { vendas, fat, liquido, cmv, lucro, taxas, juros, despesas, compras, lucroLiquido: lucro - despesas };
}

/* ---------- Roteamento ---------- */
const ROUTES = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  estoque: { title: 'Estoque', render: renderEstoque },
  vendas: { title: 'Vendas', render: renderVendas },
  caixa: { title: 'Caixa', render: renderCaixa },
  parcelamento: { title: 'Parcelamento & Juros', render: renderParcelamento },
  config: { title: 'Configurações', render: renderConfig }
};

const ui = {
  mes: currentMonth(),
  estoqueFiltro: 'estoque',
  estoqueBusca: '',
  vendaForma: '',
  vendaBusca: '',
  simValor: 3000
};

function route() {
  const key = location.hash.slice(1) || 'dashboard';
  const r = ROUTES[key] || ROUTES.dashboard;
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === key));
  $('#pageTitle').textContent = r.title;
  $('#brandName').textContent = state.config.loja || 'Wonner Loja';
  $('#sidebarFoot').innerHTML = usuario
    ? `<div class="user-box"><span class="sync" id="syncStatus">Salvo na sua conta</span><b>${esc(usuario.email)}</b><a class="btn sm" href="/">App de finanças</a><button class="btn sm" data-action="sair">Sair</button></div>`
    : '';
  nuvem.setStatus(nuvem.status);
  $('#view').innerHTML = r.render();
  $('#sidebar').classList.remove('open');
}

function rerender() { route(); }

function monthPicker() {
  return `<input type="month" data-bind="mes" value="${ui.mes}">`;
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  const r = resumoMes(ui.mes);
  const est = emEstoque();
  const investido = est.reduce((s, a) => s + a.custo, 0);
  const previsto = est.reduce((s, a) => s + (a.precoVenda || 0), 0);
  const saldo = saldoCaixa();
  const margem = r.fat ? (r.lucro / r.fat) * 100 : 0;
  const ticket = r.vendas.length ? r.fat / r.vendas.length : 0;
  const alerta = state.config.diasAlerta;
  const parados = est.filter(a => daysBetween(a.dataCompra) >= alerta);

  const vendidos = state.vendas.filter(v => v.dataCompra);
  const giro = vendidos.length ? vendidos.reduce((s, v) => s + daysBetween(v.dataCompra, v.data), 0) / vendidos.length : 0;

  const vazio = !state.aparelhos.length && !state.caixa.length;

  return `
    ${vazio ? `
    <div class="card" style="display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <div>
        <h3 style="font-size:16px">Bem-vindo! 👋</h3>
        <p class="hint">Comece lançando o dinheiro que você tem em caixa e cadastrando os aparelhos do estoque. Ou carregue dados de exemplo para conhecer o sistema.</p>
      </div>
      <div class="toolbar">
        <button class="btn" data-action="exemplo">Carregar exemplo</button>
        <button class="btn primary" data-action="novo-lancamento">Lançar caixa inicial</button>
      </div>
    </div>` : ''}

    <div class="toolbar">${monthPicker()}<span class="muted">Indicadores de vendas referentes ao mês selecionado</span></div>

    <div class="grid kpis">
      <div class="card kpi accent">
        <div class="label">🏦 Caixa disponível</div>
        <div class="value">${brl(saldo)}</div>
        <div class="sub">Disponível para comprar aparelhos</div>
      </div>
      <div class="card kpi">
        <div class="label">📦 Estoque (custo)</div>
        <div class="value">${brl(investido)}</div>
        <div class="sub">${est.length} aparelho(s) · venda prevista ${brl(previsto)}</div>
      </div>
      <div class="card kpi">
        <div class="label">📈 Lucro previsto do estoque</div>
        <div class="value ${previsto - investido >= 0 ? 'pos' : 'neg'}">${brl(previsto - investido)}</div>
        <div class="sub">Se vender tudo no preço cadastrado</div>
      </div>
      <div class="card kpi">
        <div class="label">💼 Patrimônio</div>
        <div class="value">${brl(saldo + investido)}</div>
        <div class="sub">Caixa + estoque a preço de custo</div>
      </div>
    </div>

    <div class="grid kpis">
      <div class="card kpi">
        <div class="label">Faturamento</div>
        <div class="value">${brl(r.fat)}</div>
        <div class="sub">${r.vendas.length} venda(s) · ticket ${brl(ticket)}</div>
      </div>
      <div class="card kpi">
        <div class="label">CMV (custo do que vendeu)</div>
        <div class="value">${brl(r.cmv)}</div>
        <div class="sub">${r.fat ? pct((r.cmv / r.fat) * 100) + ' do faturamento' : '—'}</div>
      </div>
      <div class="card kpi">
        <div class="label">Taxas de cartão</div>
        <div class="value neg">${brl(r.taxas)}</div>
        <div class="sub">Juros pagos pelos clientes: ${brl(r.juros)}</div>
      </div>
      <div class="card kpi">
        <div class="label">Lucro bruto</div>
        <div class="value ${r.lucro >= 0 ? 'pos' : 'neg'}">${brl(r.lucro)}</div>
        <div class="sub">Margem ${pct(margem)}</div>
      </div>
      <div class="card kpi">
        <div class="label">Lucro líquido</div>
        <div class="value ${r.lucroLiquido >= 0 ? 'pos' : 'neg'}">${brl(r.lucroLiquido)}</div>
        <div class="sub">Após despesas de ${brl(r.despesas)}</div>
      </div>
    </div>

    <div class="grid cols-3-1">
      <div class="card">
        <div class="card-head">
          <div><h3>Faturamento x Lucro</h3><p>Últimos 6 meses</p></div>
          <div class="legend"><span><i style="background:#c7d2fe"></i>Faturamento</span><span><i style="background:var(--primary)"></i>Lucro</span></div>
        </div>
        ${chart6m()}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Formas de pagamento</h3><p>${monthLabel(ui.mes)}</p></div></div>
        ${formasBreakdown(r.vendas)}
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="card-head">
          <div><h3>Aparelhos parados</h3><p>${parados.length} acima de ${alerta} dias · giro médio ${Math.round(giro)} dias até vender</p></div>
          <a class="btn sm" href="#estoque">Ver estoque</a>
        </div>
        ${faixasParado(est)}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Mais tempo em estoque</h3><p>Priorize a venda destes</p></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Aparelho</th><th>Parado</th><th class="num">Custo</th></tr></thead>
          <tbody>
            ${est.length ? [...est].sort((a, b) => a.dataCompra.localeCompare(b.dataCompra)).slice(0, 6).map(a => `
              <tr>
                <td><div class="cell-title">${esc(nomeAparelho(a))}</div><div class="cell-sub">${esc(a.cor || '')} ${a.condicao ? '· ' + esc(a.condicao) : ''}</div></td>
                <td>${paradoBadge(daysBetween(a.dataCompra))}</td>
                <td class="num">${brl(a.custo)}</td>
              </tr>`).join('') : `<tr><td colspan="3" class="empty">Nenhum aparelho em estoque.</td></tr>`}
          </tbody>
        </table></div>
      </div>
    </div>
  `;
}

function chart6m() {
  const meses = Array.from({ length: 6 }, (_, i) => shiftMonth(ui.mes, i - 5));
  const dados = meses.map(m => ({ m, ...resumoMes(m) }));
  const max = Math.max(1, ...dados.map(d => Math.max(d.fat, Math.abs(d.lucro))));
  return `<div class="chart">${dados.map(d => `
    <div class="col" title="${monthLabel(d.m)} — Faturamento ${brl(d.fat)} · Lucro ${brl(d.lucro)}">
      <div class="bars">
        <div class="bar fat" style="height:${(d.fat / max) * 100}%"></div>
        <div class="bar luc ${d.lucro < 0 ? 'neg' : ''}" style="height:${(Math.abs(d.lucro) / max) * 100}%"></div>
      </div>
      <div class="lbl">${monthLabel(d.m)}</div>
    </div>`).join('')}</div>`;
}

function formasBreakdown(vendas) {
  if (!vendas.length) return `<p class="hint">Sem vendas neste mês.</p>`;
  const total = vendas.reduce((s, v) => s + v.cobrado, 0);
  const cores = { pix: 'var(--green)', dinheiro: '#64748b', debito: 'var(--blue)', credito: 'var(--primary)' };
  return `<div class="plist">${Object.keys(FORMAS).map(f => {
    const vs = vendas.filter(v => v.forma === f);
    if (!vs.length) return '';
    const val = vs.reduce((s, v) => s + v.cobrado, 0);
    return `<div class="row">
      <div class="row-top"><span><b>${FORMAS[f].nome}</b> <span class="muted">· ${vs.length} venda(s)</span></span><span>${brl(val)} <span class="muted">${pct((val / total) * 100)}</span></span></div>
      <div class="track"><div style="width:${(val / total) * 100}%;background:${cores[f]}"></div></div>
    </div>`;
  }).join('')}</div>`;
}

function faixasParado(est) {
  const a = state.config.diasAlerta;
  const faixas = [
    { nome: `Até ${Math.round(a / 2)} dias`, min: 0, max: Math.round(a / 2), cor: 'var(--green)' },
    { nome: `${Math.round(a / 2) + 1} a ${a - 1} dias`, min: Math.round(a / 2) + 1, max: a - 1, cor: '#84cc16' },
    { nome: `${a} a ${a * 2 - 1} dias`, min: a, max: a * 2 - 1, cor: 'var(--amber)' },
    { nome: `${a * 2}+ dias`, min: a * 2, max: Infinity, cor: 'var(--red)' }
  ];
  const total = est.length || 1;
  return `<div class="plist">${faixas.map(f => {
    const itens = est.filter(x => { const d = daysBetween(x.dataCompra); return d >= f.min && d <= f.max; });
    const valor = itens.reduce((s, x) => s + x.custo, 0);
    return `<div class="row">
      <div class="row-top"><span><b>${f.nome}</b> <span class="muted">· ${itens.length} un.</span></span><span>${brl(valor)}</span></div>
      <div class="track"><div style="width:${(itens.length / total) * 100}%;background:${f.cor}"></div></div>
    </div>`;
  }).join('')}</div>`;
}

/* ---------- Estoque ---------- */
function renderEstoque() {
  const busca = ui.estoqueBusca.toLowerCase();
  let lista = state.aparelhos.filter(a => ui.estoqueFiltro === 'todos' || a.status === ui.estoqueFiltro);
  if (busca) lista = lista.filter(a => [nomeAparelho(a), a.cor, a.imei, a.fornecedor].join(' ').toLowerCase().includes(busca));
  lista.sort((a, b) => a.dataCompra.localeCompare(b.dataCompra));

  const est = emEstoque();
  const custo = est.reduce((s, a) => s + a.custo, 0);
  const prev = est.reduce((s, a) => s + (a.precoVenda || 0), 0);
  const diasMedio = est.length ? est.reduce((s, a) => s + daysBetween(a.dataCompra), 0) / est.length : 0;

  return `
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Aparelhos em estoque</div><div class="value">${est.length}</div><div class="sub">Tempo médio parado: ${Math.round(diasMedio)} dias</div></div>
      <div class="card kpi"><div class="label">Total investido</div><div class="value">${brl(custo)}</div><div class="sub">Preço de custo</div></div>
      <div class="card kpi"><div class="label">Venda prevista</div><div class="value">${brl(prev)}</div><div class="sub">Preço de venda cadastrado</div></div>
      <div class="card kpi"><div class="label">Lucro previsto</div><div class="value ${prev - custo >= 0 ? 'pos' : 'neg'}">${brl(prev - custo)}</div><div class="sub">Margem ${pct(prev ? ((prev - custo) / prev) * 100 : 0)}</div></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="toolbar">
          <div class="tabs">
            ${[['estoque', 'Em estoque'], ['vendido', 'Vendidos'], ['todos', 'Todos']].map(([k, n]) => `<button class="${ui.estoqueFiltro === k ? 'on' : ''}" data-action="filtro-estoque" data-v="${k}">${n}</button>`).join('')}
          </div>
          <input type="search" placeholder="Buscar modelo, IMEI, cor…" data-bind="estoqueBusca" value="${esc(ui.estoqueBusca)}">
        </div>
        <button class="btn primary" data-action="nova-compra">+ Comprar aparelho</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Aparelho</th><th>Condição</th><th>Compra</th><th>Parado</th>
          <th class="num">Custo</th><th class="num">Venda</th><th class="num">Lucro</th><th class="num">Margem</th><th></th>
        </tr></thead>
        <tbody>
          ${lista.length ? lista.map(a => {
            const venda = a.status === 'vendido' ? state.vendas.find(v => v.aparelhoId === a.id) : null;
            const precoV = venda ? venda.cobrado : a.precoVenda || 0;
            const lucro = venda ? venda.lucro : precoV - a.custo;
            const dias = venda ? daysBetween(a.dataCompra, venda.data) : daysBetween(a.dataCompra);
            return `<tr>
              <td><div class="cell-title">${esc(nomeAparelho(a))}</div><div class="cell-sub">${esc(a.cor || '')}${a.imei ? ' · IMEI ' + esc(a.imei) : ''}</div></td>
              <td>${a.condicao ? `<span class="badge b-gray">${esc(a.condicao)}</span>` : ''}${a.origem === 'troca' ? ' <span class="badge b-amber">troca</span>' : ''}${a.bateria ? ` <span class="cell-sub">🔋${esc(a.bateria)}%</span>` : ''}</td>
              <td>${fmtDate(a.dataCompra)}<div class="cell-sub">${esc(a.fornecedor || '')}</div></td>
              <td>${venda ? `<span class="badge b-blue">Vendido em ${dias}d</span>` : paradoBadge(dias)}</td>
              <td class="num">${brl(a.custo)}</td>
              <td class="num">${brl(precoV)}${venda ? '' : '<div class="cell-sub">previsto</div>'}</td>
              <td class="num ${lucro >= 0 ? 'pos' : 'neg'}">${brl(lucro)}</td>
              <td class="num">${pct(precoV ? (lucro / precoV) * 100 : 0)}</td>
              <td class="num">
                ${a.status === 'estoque' ? `<button class="btn sm primary" data-action="vender" data-id="${a.id}">Vender</button>` : ''}
                <button class="btn sm" data-action="editar-aparelho" data-id="${a.id}">Editar</button>
                ${a.status === 'estoque' ? `<button class="btn sm danger" data-action="excluir-aparelho" data-id="${a.id}">Excluir</button>` : ''}
              </td>
            </tr>`;
          }).join('') : `<tr><td colspan="9" class="empty">Nenhum aparelho encontrado.</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function formAparelho(a) {
  const ed = !!a;
  a = a || { dataCompra: todayISO(), condicao: 'Seminovo' };
  return `<form data-form="aparelho" data-id="${a.id || ''}">
    <div class="form-grid">
      <label class="field">Marca<input name="marca" value="${esc(a.marca)}" placeholder="Apple, Samsung, Xiaomi…" required list="marcas"></label>
      <label class="field">Modelo<input name="modelo" value="${esc(a.modelo)}" placeholder="iPhone 13" required></label>
      <label class="field">Armazenamento<input name="armazenamento" value="${esc(a.armazenamento)}" placeholder="128GB"></label>
      <label class="field">Cor<input name="cor" value="${esc(a.cor)}"></label>
      <label class="field">IMEI / Série<input name="imei" value="${esc(a.imei)}" inputmode="numeric" placeholder="*#06# no aparelho"><span class="aviso-imei" id="imeiAviso"></span></label>
      <label class="field">Condição<select name="condicao">${['Novo', 'Seminovo', 'Usado', 'Vitrine', 'Recondicionado'].map(c => `<option ${a.condicao === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field">Saúde da bateria (%)<input name="bateria" type="number" min="0" max="100" value="${esc(a.bateria)}"></label>
      <label class="field">Fornecedor<input name="fornecedor" value="${esc(a.fornecedor)}"></label>
      <label class="field">Data da compra<input name="dataCompra" type="date" value="${a.dataCompra}" required></label>
      <label class="field">Valor pago (custo)<input name="custo" type="number" step="0.01" min="0" value="${a.custo ?? ''}" required></label>
      <label class="field">Preço de venda previsto<input name="precoVenda" type="number" step="0.01" min="0" value="${a.precoVenda ?? ''}"></label>
      <div class="field" style="justify-content:flex-end"><div class="summary" id="prevLucro"></div></div>
      <label class="field full">Observações<textarea name="obs" rows="2">${esc(a.obs)}</textarea></label>
      ${ed ? '' : `<label class="check full"><input type="checkbox" name="descontar" checked> Descontar o valor do caixa (saída "Compra de aparelho")</label>`}
    </div>
    <datalist id="marcas">${['Apple', 'Samsung', 'Xiaomi', 'Motorola', 'Realme', 'Poco', 'Google', 'Asus'].map(m => `<option value="${m}">`).join('')}</datalist>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">${ed ? 'Salvar' : 'Cadastrar compra'}</button></div>
  </form>`;
}

function updatePrevLucro(form) {
  $('#imeiAviso').textContent = avisoImei(form.imei.value, form.dataset.id);
  const c = num(form.custo.value), p = num(form.precoVenda.value);
  $('#prevLucro').innerHTML = `<div><span>Lucro previsto</span><b class="${p - c >= 0 ? 'pos' : 'neg'}">${brl(p - c)}</b></div><div><span>Margem</span><b>${pct(p ? ((p - c) / p) * 100 : 0)}</b></div>`;
}

function salvarAparelho(form) {
  const f = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  const dados = {
    marca: f.marca.trim(), modelo: f.modelo.trim(), armazenamento: f.armazenamento.trim(), cor: f.cor.trim(),
    imei: f.imei.trim(), condicao: f.condicao, bateria: f.bateria, fornecedor: f.fornecedor.trim(),
    dataCompra: f.dataCompra, custo: num(f.custo), precoVenda: num(f.precoVenda), obs: f.obs.trim()
  };
  const aviso = avisoImei(dados.imei, id);
  if (/Já existe/.test(aviso)) return toast(aviso);
  if (aviso && !confirm(aviso + '\n\nSalvar assim mesmo?')) return;
  if (id) {
    const a = state.aparelhos.find(x => x.id === id);
    Object.assign(a, dados);
    const l = state.caixa.find(x => x.ref === 'compra:' + id);
    if (l) Object.assign(l, { valor: a.custo, data: a.dataCompra, descricao: 'Compra ' + nomeAparelho(a) });
    const v = state.vendas.find(x => x.aparelhoId === id);
    if (v) Object.assign(v, { custo: a.custo, lucro: round2(v.liquido - a.custo), dataCompra: a.dataCompra, descricao: nomeAparelho(a) });
    toast('Aparelho atualizado.');
  } else {
    const a = { id: uid(), status: 'estoque', ...dados };
    state.aparelhos.push(a);
    if (f.descontar) {
      state.caixa.push({ id: uid(), data: a.dataCompra, tipo: 'saida', categoria: 'Compra de aparelho', descricao: 'Compra ' + nomeAparelho(a), valor: a.custo, ref: 'compra:' + a.id });
    }
    toast('Compra cadastrada.');
  }
  save(); closeModal(); rerender();
}

function excluirAparelho(id) {
  const a = state.aparelhos.find(x => x.id === id);
  if (!confirm(`Excluir ${nomeAparelho(a)}? O lançamento de compra no caixa também será removido.`)) return;
  state.aparelhos = state.aparelhos.filter(x => x.id !== id);
  state.caixa = state.caixa.filter(x => x.ref !== 'compra:' + id);
  save(); rerender(); toast('Aparelho excluído.');
}

/* ---------- Vendas ---------- */
function renderVendas() {
  // Buscando, procura em todos os meses: quem volta pela garantia nem sempre lembra quando comprou.
  const busca = ui.vendaBusca.trim().toLowerCase();
  let vendas = busca
    ? state.vendas.filter(v => [v.descricao, v.imei, v.cliente, v.telefone, v.cpf].join(' ').toLowerCase().includes(busca))
    : state.vendas.filter(v => monthOf(v.data) === ui.mes);
  if (ui.vendaForma) vendas = vendas.filter(v => v.forma === ui.vendaForma);
  vendas.sort((a, b) => b.data.localeCompare(a.data));
  const t = k => vendas.reduce((s, v) => s + v[k], 0);
  const fat = t('cobrado'), lucro = t('lucro');

  return `
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Faturamento</div><div class="value">${brl(fat)}</div><div class="sub">${vendas.length} venda(s)</div></div>
      <div class="card kpi"><div class="label">Recebido líquido</div><div class="value">${brl(t('liquido'))}</div><div class="sub">Já descontadas as taxas</div></div>
      <div class="card kpi"><div class="label">CMV</div><div class="value">${brl(t('custo'))}</div><div class="sub">Custo dos aparelhos vendidos</div></div>
      <div class="card kpi"><div class="label">Lucro</div><div class="value ${lucro >= 0 ? 'pos' : 'neg'}">${brl(lucro)}</div><div class="sub">Margem ${pct(fat ? (lucro / fat) * 100 : 0)}</div></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="toolbar">
          ${monthPicker()}
          <select data-bind="vendaForma"><option value="">Todas as formas</option>${Object.entries(FORMAS).map(([k, f]) => `<option value="${k}" ${ui.vendaForma === k ? 'selected' : ''}>${f.nome}</option>`).join('')}</select>
          <input type="search" placeholder="Cliente, IMEI, modelo (todos os meses)" data-bind="vendaBusca" value="${esc(ui.vendaBusca)}">
        </div>
        <button class="btn primary" data-action="nova-venda">+ Nova venda</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Data</th><th>Aparelho</th><th>Cliente</th><th>Pagamento</th>
          <th class="num">Cobrado</th><th class="num">Taxa</th><th class="num">Líquido</th><th class="num">CMV</th><th class="num">Lucro</th><th></th>
        </tr></thead>
        <tbody>
          ${vendas.length ? vendas.map(v => `<tr>
            <td>${fmtDate(v.data)}</td>
            <td><div class="cell-title">${esc(v.descricao)}</div><div class="cell-sub">${v.imei ? 'IMEI ' + esc(v.imei) : ''}${v.troca ? `${v.imei ? ' · ' : ''}troca: ${esc(v.troca.modelo)} (${brl(v.troca.valor)})` : ''}</div>${garantiaBadge(v)}</td>
            <td>${esc(v.cliente || '—')}<div class="cell-sub">${esc(v.telefone || '')}</div></td>
            <td>${formaBadge(v)}${v.forma === 'credito' ? `<div class="cell-sub">${v.parcelas}x ${brl(v.parcelaValor)}${v.repassar ? ' · juros repassado' : ''}</div>` : ''}</td>
            <td class="num">${brl(v.cobrado)}</td>
            <td class="num neg">${v.taxaValor ? '-' + brl(v.taxaValor) : '—'}<div class="cell-sub">${v.taxaPct ? pct(v.taxaPct) : ''}</div></td>
            <td class="num">${brl(v.liquido)}</td>
            <td class="num">${brl(v.custo)}</td>
            <td class="num ${v.lucro >= 0 ? 'pos' : 'neg'}"><b>${brl(v.lucro)}</b><div class="cell-sub">${pct(v.cobrado ? (v.lucro / v.cobrado) * 100 : 0)}</div></td>
            <td class="num">
              <button class="btn sm" data-action="recibo" data-id="${v.id}">Recibo</button>
              ${digitos(v.telefone).length >= 10 ? `<button class="btn sm" data-action="whatsapp" data-id="${v.id}">WhatsApp</button>` : ''}
              <button class="btn sm danger" data-action="excluir-venda" data-id="${v.id}">Estornar</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="10" class="empty">Nenhuma venda neste período.</td></tr>`}
        </tbody>
        ${vendas.length ? `<tfoot><tr>
          <td colspan="4"><b>Total</b></td>
          <td class="num"><b>${brl(fat)}</b></td><td class="num neg"><b>-${brl(t('taxaValor'))}</b></td>
          <td class="num"><b>${brl(t('liquido'))}</b></td><td class="num"><b>${brl(t('custo'))}</b></td>
          <td class="num ${lucro >= 0 ? 'pos' : 'neg'}"><b>${brl(lucro)}</b></td><td></td>
        </tr></tfoot>` : ''}
      </table></div>
    </div>`;
}

function formVenda(aparelhoId) {
  const est = emEstoque().sort((a, b) => nomeAparelho(a).localeCompare(nomeAparelho(b)));
  if (!est.length) return `<p class="hint">Não há aparelhos em estoque. Cadastre uma compra primeiro.</p>
    <div class="form-actions"><button class="btn primary" data-action="nova-compra">+ Comprar aparelho</button></div>`;
  const sel = est.find(a => a.id === aparelhoId) || est[0];
  const max = state.config.taxas.credito.length;
  return `<form data-form="venda">
    <div class="form-grid">
      <label class="field full">Aparelho<select name="aparelhoId" required>${est.map(a => `<option value="${a.id}" ${a.id === sel.id ? 'selected' : ''}>${esc(nomeAparelho(a))} ${a.cor ? '· ' + esc(a.cor) : ''} — custo ${brl(a.custo)}</option>`).join('')}</select></label>
      <label class="field">Data da venda<input name="data" type="date" value="${todayISO()}" required></label>
      <label class="field">Preço à vista<input name="preco" type="number" step="0.01" min="0" value="${sel.precoVenda || ''}" required></label>
      <label class="field">Cliente<input name="cliente"></label>
      <label class="field">WhatsApp do cliente<input name="telefone" type="tel" placeholder="(11) 99999-9999"></label>
      <label class="field">CPF (opcional)<input name="cpf" inputmode="numeric"></label>
      <label class="field">Garantia (dias)<input name="garantiaDias" type="number" min="0" max="730" value="${num(state.config.garantiaDias)}"></label>
      <label class="check full"><input type="checkbox" name="temTroca"> Cliente deu um aparelho na troca</label>
      <div class="full form-grid troca-campos" id="trocaCampos" hidden>
        <label class="field">Modelo do usado<input name="trocaModelo" placeholder="Ex.: iPhone 11" list="modelosTroca"></label>
        <label class="field">Armazenamento<input name="trocaArmazenamento" placeholder="64GB"></label>
        <label class="field">Cor<input name="trocaCor"></label>
        <label class="field">Bateria (%)<input name="trocaBateria" type="number" min="0" max="100"></label>
        <label class="field">IMEI do usado<input name="trocaImei" inputmode="numeric"><span class="aviso-imei" id="trocaImeiAviso"></span></label>
        <label class="field">Valor abatido<input name="trocaValor" type="number" step="0.01" min="0"></label>
        <p class="hint full">O usado entra no estoque com esse valor como custo, e o cliente paga só a diferença.</p>
      </div>
      <label class="field">Forma de pagamento<select name="forma">${Object.entries(FORMAS).map(([k, f]) => `<option value="${k}">${f.nome}</option>`).join('')}</select></label>
      <label class="field" id="parcelasField" hidden>Parcelas<select name="parcelas">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}x (taxa ${pct(num(state.config.taxas.credito[i]))})</option>`).join('')}</select></label>
      <label class="check full" id="repassarField"><input type="checkbox" name="repassar" checked> Repassar a taxa/juros da maquininha para o cliente</label>
      <div class="full summary" id="vendaResumo"></div>
      <datalist id="modelosTroca">${[...new Set(state.aparelhos.map(x => x.modelo).filter(Boolean))].map(m => `<option value="${esc(m)}">`).join('')}</datalist>
    </div>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Confirmar venda</button></div>
  </form>`;
}

// Com troca, o usado paga parte do preço: a maquininha (e o juro) incide só
// sobre a diferença que o cliente paga em dinheiro ou cartão.
function calcVendaComTroca(form) {
  const preco = num(form.preco.value);
  const troca = form.temTroca.checked ? Math.min(num(form.trocaValor.value), preco) : 0;
  const forma = form.forma.value;
  const parcelas = forma === 'credito' ? Number(form.parcelas.value) : 1;
  const c = calcVenda({ preco: round2(preco - troca), forma, parcelas, repassar: form.repassar.checked });
  return { preco, troca, forma, parcelas, c };
}

function updateVendaResumo(form, trocouAparelho) {
  const a = state.aparelhos.find(x => x.id === form.aparelhoId.value);
  if (trocouAparelho) form.preco.value = a.precoVenda || '';
  $('#trocaCampos').hidden = !form.temTroca.checked;
  $('#trocaImeiAviso').textContent = form.temTroca.checked ? avisoImei(form.trocaImei.value) : '';
  const { troca, forma, parcelas, c } = calcVendaComTroca(form);
  $('#parcelasField').hidden = forma !== 'credito';
  $('#repassarField').hidden = c.taxaPct === 0;
  const lucro = c.liquido + troca - a.custo;
  const total = c.cobrado + troca;
  $('#vendaResumo').innerHTML = `
    ${troca ? `<div><span>Aparelho na troca</span><span>${brl(troca)}</span></div>` : ''}
    <div><span>Cliente paga${troca ? ' (diferença)' : ''}</span><b>${brl(c.cobrado)}${forma === 'credito' ? ` <span class="muted">(${parcelas}x de ${brl(c.parcelaValor)})</span>` : ''}</b></div>
    ${c.jurosCliente > 0 ? `<div><span>Juros cobrados do cliente</span><span>${brl(c.jurosCliente)}</span></div>` : ''}
    <div><span>Taxa da maquininha (${pct(c.taxaPct)})</span><span class="neg">${c.taxaValor ? '-' + brl(c.taxaValor) : '—'}</span></div>
    <div><span>Você recebe${troca ? ' em dinheiro' : ''}</span><b>${brl(c.liquido)}</b></div>
    <div><span>Custo do aparelho (CMV)</span><span>-${brl(a.custo)}</span></div>
    <div class="total"><span>Lucro</span><span class="${lucro >= 0 ? 'pos' : 'neg'}">${brl(lucro)} · ${pct(total ? (lucro / total) * 100 : 0)}</span></div>`;
}

function salvarVenda(form) {
  const f = Object.fromEntries(new FormData(form));
  const a = state.aparelhos.find(x => x.id === f.aparelhoId);
  const { preco, troca, forma, parcelas, c } = calcVendaComTroca(form);
  if (troca && !f.trocaModelo.trim()) return toast('Informe o modelo do aparelho da troca.');
  const imeiTroca = digitos(f.trocaImei);
  if (troca && imeiTroca && avisoImei(imeiTroca) && !confirm(avisoImei(imeiTroca) + '\n\nRegistrar a troca assim mesmo?')) return;
  const v = {
    id: uid(), aparelhoId: a.id, descricao: nomeAparelho(a), imei: a.imei || '', condicao: a.condicao || '', dataCompra: a.dataCompra,
    data: f.data, cliente: f.cliente.trim(), telefone: f.telefone.trim(), cpf: f.cpf.trim(),
    garantiaDias: Math.max(0, parseInt(f.garantiaDias) || 0),
    forma, parcelas, repassar: !!f.repassar && c.taxaPct > 0, preco,
    ...c, custo: a.custo
  };
  if (troca) {
    // O usado entra no estoque com o valor abatido como custo — sem saída no
    // caixa, porque foi pago com o próprio aparelho vendido.
    const usado = {
      id: uid(), status: 'estoque', origem: 'troca', marca: '', modelo: f.trocaModelo.trim(),
      armazenamento: f.trocaArmazenamento.trim(), cor: f.trocaCor.trim(), imei: imeiTroca, condicao: 'Usado',
      bateria: f.trocaBateria, fornecedor: 'Troca' + (v.cliente ? ' — ' + v.cliente : ''), dataCompra: f.data,
      custo: troca, precoVenda: 0, obs: 'Recebido na troca da venda de ' + v.descricao
    };
    state.aparelhos.push(usado);
    v.troca = { aparelhoId: usado.id, modelo: nomeAparelho(usado), cor: usado.cor, imei: usado.imei, valor: troca };
    v.pagoDinheiro = c.cobrado;
    v.cobrado = round2(c.cobrado + troca);
    v.liquido = round2(c.liquido + troca);
  }
  v.lucro = round2(v.liquido - a.custo);
  state.vendas.push(v);
  a.status = 'vendido';
  if (c.liquido > 0) {
    state.caixa.push({ id: uid(), data: v.data, tipo: 'entrada', categoria: 'Venda', descricao: 'Venda ' + v.descricao + (v.cliente ? ' — ' + v.cliente : ''), valor: c.liquido, ref: 'venda:' + v.id });
  }
  save(); closeModal(); rerender();
  toast(`Venda registrada! Lucro de ${brl(v.lucro)}.`);
  setTimeout(() => { if (confirm('Venda registrada! Imprimir o recibo com garantia agora?')) imprimirRecibo(v.id); }, 50);
}

function excluirVenda(id) {
  const v = state.vendas.find(x => x.id === id);
  if (!confirm(`Estornar a venda de ${v.descricao}? O aparelho volta para o estoque e a entrada no caixa é removida.`)) return;
  const usado = v.troca && state.aparelhos.find(x => x.id === v.troca.aparelhoId && x.status === 'estoque');
  const tirarUsado = usado && confirm(`Tirar do estoque também o aparelho que entrou na troca (${nomeAparelho(usado)})?`);
  state.vendas = state.vendas.filter(x => x.id !== id);
  state.caixa = state.caixa.filter(x => x.ref !== 'venda:' + id);
  if (tirarUsado) state.aparelhos = state.aparelhos.filter(x => x.id !== usado.id);
  const a = state.aparelhos.find(x => x.id === v.aparelhoId);
  if (a) a.status = 'estoque';
  save(); rerender(); toast('Venda estornada.');
}

function garantiaBadge(v) {
  const ate = garantiaAte(v);
  if (!ate) return '';
  return ate >= todayISO()
    ? `<span class="badge b-green">garantia até ${fmtDate(ate)}</span>`
    : `<span class="badge b-gray">garantia venceu ${fmtDate(ate)}</span>`;
}

/* ---------- Recibo e WhatsApp ---------- */
function imprimirRecibo(id) {
  const v = state.vendas.find(x => x.id === id);
  if (!v) return;
  const L = state.config;
  const ate = garantiaAte(v);
  const pago = v.troca ? v.pagoDinheiro : v.cobrado;
  const pagamento = (FORMAS[v.forma] || { nome: v.forma }).nome + (v.forma === 'credito' && v.parcelas > 1 ? ` em ${v.parcelas}x de ${brl(v.parcelaValor)}` : '');
  $('#recibo').innerHTML = `
    <div class="r-topo">
      <div><h1>${esc(L.loja)}</h1>
        ${L.documento ? `<div>CNPJ/CPF: ${esc(L.documento)}</div>` : ''}
        ${L.endereco ? `<div>${esc(L.endereco)}</div>` : ''}
        ${L.telefone ? `<div>Tel.: ${esc(L.telefone)}</div>` : ''}</div>
      <div style="text-align:right"><b>RECIBO DE VENDA</b><div>Data: ${fmtDate(v.data)}</div><div>Nº ${esc(String(v.id).slice(0, 8).toUpperCase())}</div></div>
    </div>
    <div><b>Cliente:</b> ${esc(v.cliente || '—')}${v.cpf ? ' · CPF ' + esc(v.cpf) : ''}${v.telefone ? ' · Tel. ' + esc(v.telefone) : ''}</div>
    <table>
      <tr><th>Produto</th><th>IMEI</th><th>Valor</th></tr>
      <tr><td>${esc(v.descricao)}${v.condicao ? ' (' + esc(v.condicao) + ')' : ''}</td><td>${esc(v.imei || '—')}</td><td>${brl(v.cobrado)}</td></tr>
      ${v.troca ? `<tr><td>Aparelho recebido na troca: ${esc(v.troca.modelo)}${v.troca.cor ? ' · ' + esc(v.troca.cor) : ''}</td><td>${esc(v.troca.imei || '—')}</td><td>− ${brl(v.troca.valor)}</td></tr>` : ''}
      <tr class="r-total"><td colspan="2">Total pago (${esc(pagamento)})</td><td>${brl(pago)}</td></tr>
    </table>
    ${ate ? `<p><b>Garantia:</b> ${v.garantiaDias} dias — válida até <b>${fmtDate(ate)}</b>.</p><div class="r-termos">${esc(L.termos || TERMOS_PADRAO)}</div>` : '<p><b>Sem garantia.</b></p>'}
    ${v.troca ? '<p class="r-pequeno">O cliente declara ser o proprietário do aparelho entregue na troca e que ele não tem origem ilícita, bloqueio ou restrição.</p>' : ''}
    <div class="r-assin"><div>${esc(L.loja)}</div><div>${esc(v.cliente || 'Cliente')}</div></div>`;
  window.print();
}

function mandarWhatsapp(id) {
  const v = state.vendas.find(x => x.id === id);
  if (!v) return;
  const L = state.config;
  const ate = garantiaAte(v);
  let tel = digitos(v.telefone);
  if (tel.length <= 11) tel = '55' + tel;
  const texto = `Olá${v.cliente ? ', ' + v.cliente.split(' ')[0] : ''}! Obrigado pela compra na ${L.loja}.\n\n` +
    `*Recibo de venda* — ${fmtDate(v.data)}\nProduto: ${v.descricao}` + (v.imei ? `\nIMEI: ${v.imei}` : '') +
    (v.troca ? `\nTroca: ${v.troca.modelo} (− ${brl(v.troca.valor)})` : '') +
    `\nTotal pago: ${brl(v.troca ? v.pagoDinheiro : v.cobrado)} (${(FORMAS[v.forma] || { nome: v.forma }).nome}${v.forma === 'credito' && v.parcelas > 1 ? ' ' + v.parcelas + 'x' : ''})` +
    (ate ? `\n\n*Garantia:* ${v.garantiaDias} dias, até ${fmtDate(ate)}.\n${L.termos || TERMOS_PADRAO}` : '');
  window.open('https://wa.me/' + tel + '?text=' + encodeURIComponent(texto), '_blank', 'noopener');
}

/* ---------- Caixa ---------- */
function renderCaixa() {
  const saldo = saldoCaixa();
  const doMes = state.caixa.filter(l => monthOf(l.data) === ui.mes).sort((a, b) => b.data.localeCompare(a.data));
  const ent = doMes.filter(l => l.tipo === 'entrada').reduce((s, l) => s + l.valor, 0);
  const sai = doMes.filter(l => l.tipo === 'saida').reduce((s, l) => s + l.valor, 0);
  const porCat = {};
  doMes.forEach(l => { porCat[l.categoria] = (porCat[l.categoria] || 0) + (l.tipo === 'entrada' ? l.valor : -l.valor); });

  return `
    <div class="grid kpis">
      <div class="card kpi accent"><div class="label">Saldo em caixa</div><div class="value">${brl(saldo)}</div><div class="sub">Disponível para comprar aparelhos</div></div>
      <div class="card kpi"><div class="label">Entradas no mês</div><div class="value pos">${brl(ent)}</div></div>
      <div class="card kpi"><div class="label">Saídas no mês</div><div class="value neg">${brl(sai)}</div></div>
      <div class="card kpi"><div class="label">Resultado do mês</div><div class="value ${ent - sai >= 0 ? 'pos' : 'neg'}">${brl(ent - sai)}</div></div>
    </div>
    <div class="grid cols-3-1">
      <div class="card">
        <div class="card-head">
          <div class="toolbar">${monthPicker()}</div>
          <button class="btn primary" data-action="novo-lancamento">+ Lançamento</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th><th></th></tr></thead>
          <tbody>
            ${doMes.length ? doMes.map(l => `<tr>
              <td>${fmtDate(l.data)}</td>
              <td>${esc(l.descricao || '—')}</td>
              <td><span class="badge ${l.tipo === 'entrada' ? 'b-green' : 'b-red'}">${esc(l.categoria)}</span></td>
              <td class="num ${l.tipo === 'entrada' ? 'pos' : 'neg'}"><b>${l.tipo === 'entrada' ? '+' : '-'}${brl(l.valor)}</b></td>
              <td class="num">${l.ref ? '<span class="cell-sub">automático</span>' : `<button class="btn sm danger" data-action="excluir-lancamento" data-id="${l.id}">Excluir</button>`}</td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty">Nenhum lançamento neste mês.</td></tr>`}
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Por categoria</h3><p>${monthLabel(ui.mes)}</p></div></div>
        ${Object.keys(porCat).length ? `<div class="summary">${Object.entries(porCat).map(([k, v]) => `<div><span>${esc(k)}</span><b class="${v >= 0 ? 'pos' : 'neg'}">${brl(v)}</b></div>`).join('')}</div>` : '<p class="hint">Sem movimentação.</p>'}
        <p class="hint" style="margin-top:14px">Compras de aparelhos e vendas entram no caixa automaticamente. Use “Lançamento” para aportes, despesas (aluguel, frete, peças…) e retiradas.</p>
      </div>
    </div>`;
}

function formLancamento() {
  return `<form data-form="lancamento">
    <div class="form-grid">
      <label class="field">Tipo<select name="tipo"><option value="entrada">Entrada</option><option value="saida">Saída</option></select></label>
      <label class="field">Categoria<select name="categoria">${CATEGORIAS_CAIXA.entrada.map(c => `<option>${c}</option>`).join('')}</select></label>
      <label class="field">Data<input name="data" type="date" value="${todayISO()}" required></label>
      <label class="field">Valor<input name="valor" type="number" step="0.01" min="0.01" required></label>
      <label class="field full">Descrição<input name="descricao" placeholder="Ex.: Caixa inicial, aluguel, frete…"></label>
    </div>
    <div class="form-actions"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Lançar</button></div>
  </form>`;
}

function salvarLancamento(form) {
  const f = Object.fromEntries(new FormData(form));
  state.caixa.push({ id: uid(), data: f.data, tipo: f.tipo, categoria: f.categoria, descricao: f.descricao.trim(), valor: num(f.valor) });
  save(); closeModal(); rerender(); toast('Lançamento registrado.');
}

/* ---------- Parcelamento & Juros ---------- */
function renderParcelamento() {
  const valor = num(ui.simValor);
  const t = state.config.taxas;
  const r = resumoMes(ui.mes);
  const cartao = r.vendas.filter(v => v.forma === 'credito' || v.forma === 'debito');
  const pix = r.vendas.filter(v => v.forma === 'pix' || v.forma === 'dinheiro');
  const soma = (vs, k) => vs.reduce((s, v) => s + v[k], 0);

  return `
    <div class="grid cols-3-1">
      <div class="card">
        <div class="card-head">
          <div><h3>Simulador de parcelamento</h3><p>Quanto cobrar do cliente para receber o valor à vista</p></div>
          <div class="toolbar"><span class="muted">Valor à vista</span><input type="number" step="0.01" min="0" data-bind="simValor" value="${ui.simValor}" style="width:140px"></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Forma</th><th class="num">Taxa</th><th class="num">Cliente paga (repassando)</th><th class="num">Parcela</th><th class="num">Juros ao cliente</th><th class="num">Você recebe sem repassar</th></tr></thead>
          <tbody>
            ${[['pix', 1], ['debito', 1], ...t.credito.map((_, i) => ['credito', i + 1])].map(([forma, n]) => {
              const rep = calcVenda({ preco: valor, forma, parcelas: n, repassar: true });
              const sem = calcVenda({ preco: valor, forma, parcelas: n, repassar: false });
              return `<tr>
                <td><b>${forma === 'credito' ? `Crédito ${n}x` : FORMAS[forma].nome}</b></td>
                <td class="num">${pct(rep.taxaPct)}</td>
                <td class="num"><b>${brl(rep.cobrado)}</b></td>
                <td class="num">${forma === 'credito' ? `${n}x ${brl(rep.parcelaValor)}` : '—'}</td>
                <td class="num ${rep.jurosCliente ? 'neg' : ''}">${rep.jurosCliente ? '+' + brl(rep.jurosCliente) : '—'}</td>
                <td class="num">${brl(sem.liquido)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card">
          <div class="card-head"><div><h3>Pix x Cartão</h3><p>${monthLabel(ui.mes)}</p></div>${monthPicker()}</div>
          <div class="summary">
            <div><span>Pix / dinheiro</span><b>${pix.length} · ${brl(soma(pix, 'cobrado'))}</b></div>
            <div><span>Cartão (débito/crédito)</span><b>${cartao.length} · ${brl(soma(cartao, 'cobrado'))}</b></div>
            <div><span>Juros pagos pelos clientes</span><b>${brl(r.juros)}</b></div>
            <div><span>Taxas pagas à maquininha</span><b class="neg">-${brl(r.taxas)}</b></div>
            <div class="total"><span>Custo de taxa absorvido por você</span><span class="neg">${brl(Math.max(0, r.taxas - r.juros))}</span></div>
          </div>
        </div>
        <div class="card">
          <h3 style="font-size:15px;margin-bottom:8px">Como funciona</h3>
          <p class="hint"><b>Repassando:</b> o cliente paga o valor + a taxa, e você recebe o preço à vista cheio.<br><b>Sem repassar:</b> o cliente paga o preço à vista e a taxa sai do seu lucro.<br><br>As taxas são editáveis em <a href="#config" style="color:var(--primary);font-weight:600">Configurações</a>.</p>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Vendas parceladas no mês</h3></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Aparelho</th><th>Cliente</th><th>Pagamento</th><th class="num">À vista</th><th class="num">Cobrado</th><th class="num">Juros cliente</th><th class="num">Taxa</th><th class="num">Líquido</th></tr></thead>
        <tbody>
          ${cartao.length ? cartao.map(v => `<tr>
            <td>${fmtDate(v.data)}</td><td>${esc(v.descricao)}</td><td>${esc(v.cliente || '—')}</td>
            <td>${formaBadge(v)}</td><td class="num">${brl(v.preco)}</td><td class="num">${brl(v.cobrado)}</td>
            <td class="num">${v.jurosCliente ? brl(v.jurosCliente) : '—'}</td><td class="num neg">-${brl(v.taxaValor)}</td><td class="num"><b>${brl(v.liquido)}</b></td>
          </tr>`).join('') : `<tr><td colspan="9" class="empty">Nenhuma venda no cartão neste mês.</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- Configurações ---------- */
function renderConfig() {
  const c = state.config;
  return `
    <div class="grid cols-2">
      <form class="card" data-form="config">
        <div class="card-head"><div><h3>Loja e taxas da maquininha</h3><p>Usadas no cálculo de juros e lucro das vendas</p></div></div>
        <div class="form-grid">
          <label class="field">Nome da loja<input name="loja" value="${esc(c.loja)}"></label>
          <label class="field">Alerta de aparelho parado (dias)<input name="diasAlerta" type="number" min="1" value="${c.diasAlerta}"></label>
          <label class="field">Taxa Pix (%)<input name="pix" type="number" step="0.01" min="0" value="${c.taxas.pix}"></label>
          <label class="field">Taxa Débito (%)<input name="debito" type="number" step="0.01" min="0" value="${c.taxas.debito}"></label>
          ${c.taxas.credito.map((v, i) => `<label class="field">Crédito ${i + 1}x (%)<input name="credito${i}" type="number" step="0.01" min="0" value="${v}"></label>`).join('')}
        </div>
        <div class="card-head" style="margin-top:22px"><div><h3>Recibo e garantia</h3><p>Aparecem no recibo impresso e na mensagem de WhatsApp</p></div></div>
        <div class="form-grid">
          <label class="field">CNPJ / CPF<input name="documento" value="${esc(c.documento)}"></label>
          <label class="field">Telefone / WhatsApp<input name="telefone" value="${esc(c.telefone)}"></label>
          <label class="field full">Endereço<input name="endereco" value="${esc(c.endereco)}"></label>
          <label class="field">Garantia padrão (dias)<input name="garantiaDias" type="number" min="0" max="730" value="${num(c.garantiaDias)}"></label>
          <label class="field full">Termos da garantia<textarea name="termos" rows="4" maxlength="1500">${esc(c.termos)}</textarea></label>
        </div>
        <div class="form-actions"><button class="btn primary">Salvar configurações</button></div>
      </form>
      <div class="grid" style="align-content:start">
        <div class="card">
          <div class="card-head"><div><h3>Backup dos dados</h3><p>Seus dados ficam salvos na sua conta. Baixe uma cópia de vez em quando por segurança.</p></div></div>
          <div class="toolbar">
            <button class="btn primary" data-action="exportar">⬇ Baixar backup</button>
            <label class="btn">⬆ Restaurar backup<input type="file" accept="application/json" data-action="importar" hidden></label>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Zona de perigo</h3></div></div>
          <div class="toolbar">
            <button class="btn" data-action="exemplo">Carregar dados de exemplo</button>
            <button class="btn danger" data-action="limpar">Apagar todos os dados</button>
          </div>
        </div>
      </div>
    </div>`;
}

function salvarConfig(form) {
  const f = Object.fromEntries(new FormData(form));
  const c = state.config;
  c.loja = f.loja.trim() || 'Minha Loja';
  c.diasAlerta = Math.max(1, parseInt(f.diasAlerta) || 30);
  c.documento = f.documento.trim();
  c.telefone = f.telefone.trim();
  c.endereco = f.endereco.trim();
  c.garantiaDias = Math.min(730, Math.max(0, parseInt(f.garantiaDias) || 0));
  c.termos = f.termos.trim() || TERMOS_PADRAO;
  c.taxas.pix = num(f.pix);
  c.taxas.debito = num(f.debito);
  c.taxas.credito = c.taxas.credito.map((_, i) => num(f['credito' + i]));
  save(); rerender(); toast('Configurações salvas.');
}

function exportar() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `backup-wonner-loja-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Backups do CelGestor (antes de virar Wonner Loja) têm ids curtos, e o servidor
// só aceita UUID. Troca cada id e corrige as ligações (venda → aparelho, caixa → compra/venda).
function reidentificar(s) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const novo = {};
  const id = old => old == null ? old : UUID.test(old) ? old : (novo[old] = novo[old] || uid());
  const aparelhos = s.aparelhos.map(a => ({ ...a, id: id(a.id) }));
  const vendas = s.vendas.map(v => ({
    ...v, id: id(v.id), aparelhoId: id(v.aparelhoId),
    ...(v.troca ? { troca: { ...v.troca, aparelhoId: id(v.troca.aparelhoId) } } : {})
  }));
  const caixa = s.caixa.map(l => ({
    ...l, id: id(l.id), ...(l.ref ? { ref: l.ref.replace(/:(.+)$/, (_, x) => ':' + id(x)) } : {})
  }));
  return { ...s, aparelhos, vendas, caixa };
}

function importar(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!Array.isArray(s.aparelhos) || !Array.isArray(s.vendas) || !Array.isArray(s.caixa)) throw new Error();
      if (!confirm('Restaurar este backup? Os dados atuais serão substituídos.')) return;
      state = normalize(reidentificar(s));
      save(); rerender(); toast('Backup restaurado.');
    } catch { toast('Arquivo de backup inválido.'); }
  };
  reader.readAsText(file);
}

function carregarExemplo() {
  if ((state.aparelhos.length || state.caixa.length) && !confirm('Substituir os dados atuais por dados de exemplo?')) return;
  const config = state.config;
  state = { config, aparelhos: [], vendas: [], caixa: [] };
  const diasAtras = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv-SE'); };
  state.caixa.push({ id: uid(), data: diasAtras(170), tipo: 'entrada', categoria: 'Aporte', descricao: 'Caixa inicial', valor: 40000 });
  const modelos = [
    ['Apple', 'iPhone 13', '128GB', 'Meia-noite', 'Seminovo', 2350, 2999],
    ['Apple', 'iPhone 14 Pro', '256GB', 'Roxo-profundo', 'Seminovo', 4300, 5299],
    ['Apple', 'iPhone 12', '64GB', 'Azul', 'Usado', 1500, 1999],
    ['Samsung', 'Galaxy S23', '256GB', 'Preto', 'Seminovo', 2400, 3099],
    ['Xiaomi', 'Redmi Note 13', '256GB', 'Verde', 'Novo', 1050, 1449],
    ['Motorola', 'Edge 40', '256GB', 'Preto', 'Novo', 1600, 2199],
    ['Apple', 'iPhone 15', '128GB', 'Rosa', 'Seminovo', 3900, 4699],
    ['Samsung', 'Galaxy A55', '128GB', 'Azul', 'Novo', 1500, 1999],
    ['Apple', 'iPhone 11', '128GB', 'Branco', 'Usado', 1150, 1599],
    ['Xiaomi', 'Poco X6 Pro', '512GB', 'Amarelo', 'Novo', 1700, 2299],
    ['Apple', 'iPhone 13 Pro Max', '256GB', 'Grafite', 'Seminovo', 3800, 4599],
    ['Samsung', 'Galaxy S22', '128GB', 'Branco', 'Usado', 1600, 2099]
  ];
  // índice do aparelho → [dias até vender, forma, parcelas]
  const vendidos = { 0: [12, 'pix', 1], 1: [25, 'credito', 10], 2: [9, 'pix', 1], 3: [40, 'credito', 12], 4: [18, 'debito', 1], 5: [30, 'credito', 3], 8: [45, 'credito', 6], 9: [38, 'pix', 1], 10: [20, 'credito', 12] };
  modelos.forEach((m, i) => {
    const compra = 160 - i * 13;
    const a = { id: uid(), status: 'estoque', marca: m[0], modelo: m[1], armazenamento: m[2], cor: m[3], condicao: m[4], bateria: m[4] === 'Novo' ? 100 : 85 + (i % 10), fornecedor: i % 2 ? 'Fornecedor SP' : 'Particular', imei: String(350000000000000 + i * 7919), dataCompra: diasAtras(compra), custo: m[5], precoVenda: m[6], obs: '' };
    state.aparelhos.push(a);
    state.caixa.push({ id: uid(), data: a.dataCompra, tipo: 'saida', categoria: 'Compra de aparelho', descricao: 'Compra ' + nomeAparelho(a), valor: a.custo, ref: 'compra:' + a.id });
    if (vendidos[i]) {
      const [dias, forma, parcelas] = vendidos[i];
      const data = diasAtras(Math.max(0, compra - dias));
      const c = calcVenda({ preco: a.precoVenda, forma, parcelas, repassar: i % 3 !== 2 });
      const v = { id: uid(), aparelhoId: a.id, descricao: nomeAparelho(a), dataCompra: a.dataCompra, data, cliente: ['Ana Souza', 'Bruno Lima', 'Carla Dias', 'Diego Rocha', 'Elisa Prado', 'Felipe Melo', 'Gabi Nunes', 'Hugo Reis', 'Igor Alves', 'Júlia Castro', 'Lucas Pinto'][i], telefone: '', forma, parcelas, repassar: i % 3 !== 2 && c.taxaPct > 0, preco: a.precoVenda, ...c, custo: a.custo, lucro: round2(c.liquido - a.custo) };
      state.vendas.push(v);
      a.status = 'vendido';
      state.caixa.push({ id: uid(), data, tipo: 'entrada', categoria: 'Venda', descricao: 'Venda ' + v.descricao + ' — ' + v.cliente, valor: v.liquido, ref: 'venda:' + v.id });
    }
  });
  [150, 120, 90, 60, 30, 0].forEach(n => state.caixa.push({ id: uid(), data: diasAtras(n), tipo: 'saida', categoria: 'Despesa', descricao: 'Aluguel e internet', valor: 1200 }));
  save(); rerender(); toast('Dados de exemplo carregados.');
}

/* ---------- Modal ---------- */
function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  const form = $('#modalBody form');
  if (form?.dataset.form === 'venda') updateVendaResumo(form);
  if (form?.dataset.form === 'aparelho') updatePrevLucro(form);
  setTimeout(() => $('#modalBody input:not([type=hidden]), #modalBody select')?.focus(), 30);
}

function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

/* ---------- Eventos ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]') || e.target.id === 'modal') return closeModal();
  if (e.target.closest('#menuBtn')) return $('#sidebar').classList.toggle('open');
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  if (el.dataset.action === 'sair') return sair();
  if (!usuario) return; // dados ainda não chegaram do servidor
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'nova-compra': return openModal('Comprar aparelho', formAparelho());
    case 'editar-aparelho': return openModal('Editar aparelho', formAparelho(state.aparelhos.find(a => a.id === id)));
    case 'excluir-aparelho': return excluirAparelho(id);
    case 'nova-venda': return openModal('Nova venda', formVenda());
    case 'vender': return openModal('Nova venda', formVenda(id));
    case 'excluir-venda': return excluirVenda(id);
    case 'recibo': return imprimirRecibo(id);
    case 'whatsapp': return mandarWhatsapp(id);
    case 'novo-lancamento': return openModal('Lançamento no caixa', formLancamento());
    case 'excluir-lancamento':
      if (!confirm('Excluir este lançamento?')) return;
      state.caixa = state.caixa.filter(l => l.id !== id);
      save(); rerender(); return toast('Lançamento excluído.');
    case 'filtro-estoque': ui.estoqueFiltro = el.dataset.v; return rerender();
    case 'exportar': return exportar();
    case 'sair': return sair();
    case 'exemplo': return carregarExemplo();
    case 'limpar':
      if (!confirm('Apagar TODOS os dados? Esta ação não pode ser desfeita. Faça um backup antes.')) return;
      state = { config: state.config, aparelhos: [], vendas: [], caixa: [] };
      save(); rerender(); return toast('Dados apagados.');
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind) {
    ui[t.dataset.bind] = t.value;
    const pos = t.selectionStart;
    rerender();
    const again = document.querySelector(`[data-bind="${t.dataset.bind}"]`);
    if (again && t.type !== 'month') { again.focus(); try { again.setSelectionRange(pos, pos); } catch { } }
    return;
  }
  const form = t.form;
  if (form?.dataset.form === 'venda') updateVendaResumo(form, t.name === 'aparelhoId');
  if (form?.dataset.form === 'aparelho') updatePrevLucro(form);
  if (form?.dataset.form === 'lancamento' && t.name === 'tipo') {
    form.categoria.innerHTML = CATEGORIAS_CAIXA[t.value].map(c => `<option>${c}</option>`).join('');
  }
});

document.addEventListener('change', e => {
  if (e.target.dataset.action === 'importar' && e.target.files[0]) importar(e.target.files[0]);
  if (e.target.form?.dataset.form === 'venda') updateVendaResumo(e.target.form, e.target.name === 'aparelhoId');
});

document.addEventListener('submit', e => {
  const form = e.target;
  e.preventDefault();
  ({ aparelho: salvarAparelho, venda: salvarVenda, lancamento: salvarLancamento, config: salvarConfig })[form.dataset.form]?.(form);
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

window.addEventListener('hashchange', () => { if (usuario) route(); });

/* ---------- Login (contas do Wonner Sols) ---------- */
const auth = {
  modo: 'login',
  textos: {
    login: ['Entrar', 'Acesse sua loja.', 'Entrar'],
    cadastro: ['Criar conta', 'Cadastre sua loja. A senha precisa de pelo menos 8 caracteres.', 'Criar conta'],
    recuperar: ['Recuperar senha', 'Enviaremos um link para redefinir sua senha.', 'Enviar link']
  },
  set(modo) {
    this.modo = modo;
    const [titulo, dica, botao] = this.textos[modo];
    $('#authTitle').textContent = titulo;
    $('#authHint').textContent = dica;
    $('#authSubmit').textContent = botao;
    $('#authSubmit').hidden = false;
    const form = $('#authForm');
    form.email.closest('label').hidden = false;
    $('#authSenha').hidden = modo === 'recuperar';
    form.senha.required = modo !== 'recuperar';
    form.senha.minLength = modo === 'cadastro' ? 8 : 1;
    form.senha.autocomplete = modo === 'login' ? 'current-password' : 'new-password';
    document.querySelectorAll('[data-auth]').forEach(a => (a.hidden = modo === 'login' ? a.dataset.auth === 'login' : a.dataset.auth !== 'login'));
    $('#authSemAcesso').hidden = true;
    this.msg('');
  },
  msg(texto, ok) {
    const el = $('#authMsg');
    el.hidden = !texto;
    el.textContent = texto;
    el.classList.toggle('ok', !!ok);
  },
  // Conta sem a loja liberada: o mesmo cartão, só com o aviso e a saída.
  semAcesso(texto) {
    $('#auth').hidden = false;
    $('#authTitle').textContent = 'Loja não liberada';
    $('#authHint').textContent = texto || 'A Wonner Loja ainda não foi liberada para esta conta. Fale com o suporte para liberar.';
    $('#authForm').email.closest('label').hidden = true;
    $('#authSenha').hidden = true;
    $('#authSubmit').hidden = true;
    document.querySelectorAll('[data-auth]').forEach(a => (a.hidden = true));
    $('#authSemAcesso').hidden = false;
    this.msg('');
  }
};

$('#authForm').addEventListener('click', e => {
  const a = e.target.closest('[data-auth]');
  if (a) { e.preventDefault(); auth.set(a.dataset.auth); }
});

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  e.stopPropagation();
  const f = e.target;
  const email = f.email.value.trim(), password = f.senha.value;
  const btn = $('#authSubmit');
  btn.disabled = true;
  auth.msg('');
  try {
    if (auth.modo === 'login') {
      await api('POST', '/api/auth/login', { email, password });
      await iniciar();
    } else if (auth.modo === 'cadastro') {
      // "produto: loja" faz a conta já nascer com a loja liberada.
      const r = await api('POST', '/api/auth/signup', { email, password, produto: 'loja' });
      if (r && r.aprovado === false) {
        auth.set('login');
        auth.msg('Conta criada! Ela será liberada em breve — você recebe um aviso por e-mail.', true);
      } else {
        await iniciar();
      }
    } else if (auth.modo === 'recuperar') {
      await api('POST', '/api/auth/esqueci', { email });
      auth.msg('Se o e-mail tiver conta, você vai receber o link em instantes.', true);
    }
  } catch (err) {
    auth.msg((err && err.message) || 'Não foi possível concluir agora.');
  } finally {
    btn.disabled = false;
  }
});

async function iniciar() {
  let me;
  try {
    me = await api('GET', '/api/auth/me');
  } catch (e) {
    $('#auth').hidden = false;
    if (e.status !== 401) auth.msg((e && e.message) || 'Sem conexão com o servidor.');
    return;
  }
  try {
    const cfg = await api('GET', '/api/config');
    if (!me.isAdmin && !(cfg && cfg.minhasVendas)) return auth.semAcesso();
    // "usuario" só depois dos dados: antes disso, um cadastro feito na tela
    // seria apagado quando a lista do servidor chegasse.
    await nuvem.baixar();
    usuario = { email: me.email, isAdmin: !!me.isAdmin };
  } catch (e) {
    console.error(e);
    usuario = null;
    if (e && e.status === 403) return auth.semAcesso();
    if (e && e.status === 503) return auth.semAcesso(e.message);
    $('#auth').hidden = false;
    auth.msg('Não foi possível carregar seus dados: ' + ((e && e.message) || 'verifique a internet') + '.');
    return;
  }
  $('#auth').hidden = true;
  route();
}

async function sair() {
  await nuvem.fila;
  await api('POST', '/api/auth/logout').catch(() => {});
  location.reload();
}

auth.set('login');
iniciar();
