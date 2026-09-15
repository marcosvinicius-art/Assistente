#!/usr/bin/env python3
"""Calcula e interpreta indices financeiros a partir das demonstracoes de uma empresa.

Uso:
    python ratio_calculator.py financial_data.json
    python ratio_calculator.py financial_data.json --format json

Somente biblioteca padrao. O JSON de entrada esta documentado no SKILL.md e ha um
exemplo completo em examples/financial_data.json.
"""

import argparse
import json
import sys

try:  # console do Windows costuma vir em cp1252 e quebra os acentos do relatorio
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# --------------------------------------------------------------------------
# Leitura tolerante do JSON
# --------------------------------------------------------------------------

# Aceita chaves em ingles (padrao) e os equivalentes em portugues, porque dados
# reais chegam nos dois idiomas dependendo de onde foram exportados.
ALIASES = {
    "revenue": ["receita_liquida", "receita", "vendas"],
    "cogs": ["cmv", "custo_mercadoria_vendida", "custo_produtos_vendidos"],
    "gross_profit": ["lucro_bruto"],
    "operating_expenses": ["despesas_operacionais"],
    "operating_income": ["lucro_operacional", "ebit"],
    "depreciation_amortization": ["depreciacao_amortizacao", "depreciacao"],
    "ebitda": ["lajida"],
    "interest_expense": ["despesa_juros", "juros"],
    "net_income": ["lucro_liquido"],
    "cash": ["caixa", "caixa_equivalentes", "disponibilidades"],
    "short_term_investments": ["aplicacoes_curto_prazo", "aplicacoes_financeiras"],
    "accounts_receivable": ["contas_receber", "clientes"],
    "inventory": ["estoques", "estoque"],
    "current_assets": ["ativo_circulante"],
    "total_assets": ["ativo_total", "ativos_totais"],
    "current_liabilities": ["passivo_circulante"],
    "total_debt": ["divida_total", "divida_bruta"],
    "total_liabilities": ["passivo_total"],
    "equity": ["patrimonio_liquido", "pl"],
    "share_price": ["preco_acao", "cotacao"],
    "shares_outstanding": ["acoes_em_circulacao", "quantidade_acoes"],
    "eps_growth_pct": ["crescimento_lpa_pct", "crescimento_lucro_pct"],
    "principal": ["amortizacao", "principal_divida"],
    "interest": ["juros_periodo"],
}

SECTIONS = {
    "income_statement": ["dre", "demonstracao_resultado"],
    "balance_sheet": ["balanco", "balanco_patrimonial"],
    "market": ["mercado"],
    "debt_service": ["servico_divida"],
}


def section(data, canonical):
    """Devolve uma secao do JSON aceitando o nome em ingles ou portugues."""
    if canonical in data and isinstance(data[canonical], dict):
        return data[canonical]
    for alt in SECTIONS.get(canonical, []):
        if alt in data and isinstance(data[alt], dict):
            return data[alt]
    return {}


def get(src, canonical):
    """Le um campo aceitando apelidos. Devolve float ou None (campo ausente)."""
    if not isinstance(src, dict):
        return None
    candidates = [canonical] + ALIASES.get(canonical, [])
    for key in candidates:
        if key in src and src[key] is not None:
            try:
                return float(src[key])
            except (TypeError, ValueError):
                return None
    return None


def div(a, b):
    """Divisao que devolve None em vez de explodir com dado faltando ou zero."""
    if a is None or b is None or b == 0:
        return None
    return a / b


def avg(current, previous):
    """Saldo medio quando ha periodo anterior; senao o saldo final."""
    if current is None:
        return None
    if previous is None:
        return current
    return (current + previous) / 2


# --------------------------------------------------------------------------
# Normalizacao: preenche o que da para derivar
# --------------------------------------------------------------------------

def read_statements(data):
    dre = section(data, "income_statement")
    bal = section(data, "balance_sheet")
    mkt = section(data, "market")
    ds = section(data, "debt_service")

    f = {
        "revenue": get(dre, "revenue"),
        "cogs": get(dre, "cogs"),
        "gross_profit": get(dre, "gross_profit"),
        "operating_expenses": get(dre, "operating_expenses"),
        "operating_income": get(dre, "operating_income"),
        "depreciation_amortization": get(dre, "depreciation_amortization"),
        "ebitda": get(dre, "ebitda"),
        "interest_expense": get(dre, "interest_expense"),
        "net_income": get(dre, "net_income"),
        "cash": get(bal, "cash"),
        "short_term_investments": get(bal, "short_term_investments"),
        "accounts_receivable": get(bal, "accounts_receivable"),
        "inventory": get(bal, "inventory"),
        "current_assets": get(bal, "current_assets"),
        "total_assets": get(bal, "total_assets"),
        "current_liabilities": get(bal, "current_liabilities"),
        "total_debt": get(bal, "total_debt"),
        "total_liabilities": get(bal, "total_liabilities"),
        "equity": get(bal, "equity"),
        "share_price": get(mkt, "share_price"),
        "shares_outstanding": get(mkt, "shares_outstanding"),
        "eps_growth_pct": get(mkt, "eps_growth_pct"),
        "principal": get(ds, "principal"),
        "interest": get(ds, "interest"),
    }

    # Derivacoes: so preenchem o que nao veio pronto.
    if f["gross_profit"] is None and f["revenue"] is not None and f["cogs"] is not None:
        f["gross_profit"] = f["revenue"] - f["cogs"]

    if f["operating_income"] is None and f["gross_profit"] is not None \
            and f["operating_expenses"] is not None:
        f["operating_income"] = f["gross_profit"] - f["operating_expenses"]

    if f["ebitda"] is None and f["operating_income"] is not None \
            and f["depreciation_amortization"] is not None:
        f["ebitda"] = f["operating_income"] + f["depreciation_amortization"]

    if f["total_debt"] is None and f["total_liabilities"] is not None:
        f["total_debt"] = f["total_liabilities"]

    if f["equity"] is None and f["total_assets"] is not None \
            and f["total_liabilities"] is not None:
        f["equity"] = f["total_assets"] - f["total_liabilities"]

    f["market_cap"] = None
    if f["share_price"] is not None and f["shares_outstanding"] is not None:
        f["market_cap"] = f["share_price"] * f["shares_outstanding"]

    # Enterprise value = valor de mercado + divida - caixa
    f["enterprise_value"] = None
    if f["market_cap"] is not None:
        caixa = (f["cash"] or 0) + (f["short_term_investments"] or 0)
        f["enterprise_value"] = f["market_cap"] + (f["total_debt"] or 0) - caixa

    f["eps"] = div(f["net_income"], f["shares_outstanding"])
    return f


# --------------------------------------------------------------------------
# Faixas de interpretacao
# --------------------------------------------------------------------------

# "higher": quanto maior melhor. Os limites sao referencias gerais de mercado;
# setores diferem muito, por isso o benchmark do proprio setor, quando informado,
# sempre prevalece na leitura.
BANDS = {
    "roe": ("higher", 0.15, 0.08),
    "roa": ("higher", 0.05, 0.02),
    "margem_bruta": ("higher", 0.40, 0.20),
    "margem_operacional": ("higher", 0.15, 0.05),
    "margem_liquida": ("higher", 0.10, 0.03),
    "liquidez_corrente": ("higher", 1.50, 1.00),
    "liquidez_seca": ("higher", 1.00, 0.70),
    "liquidez_caixa": ("higher", 0.50, 0.20),
    "divida_pl": ("lower", 1.00, 2.00),
    "cobertura_juros": ("higher", 3.00, 1.50),
    "dscr": ("higher", 1.25, 1.00),
    "giro_ativos": ("higher", 1.00, 0.50),
    "giro_estoque": ("higher", 6.00, 3.00),
    "giro_receber": ("higher", 8.00, 4.00),
    "dso": ("lower", 45.0, 75.0),
}

VERDICTS = {"good": "saudavel", "warn": "atencao", "bad": "critico"}


def verdict_for(key, value):
    """Classifica um indice. Multiplos de avaliacao nao entram: 'P/L baixo' tanto
    pode ser barganha quanto empresa em deterioracao, entao so comparamos."""
    if value is None or key not in BANDS:
        return None
    direction, good, warn = BANDS[key]
    if direction == "higher":
        if value >= good:
            return "good"
        return "warn" if value >= warn else "bad"
    if value <= good:
        return "good"
    return "warn" if value <= warn else "bad"


# --------------------------------------------------------------------------
# Calculo dos indices
# --------------------------------------------------------------------------

def compute_ratios(f, prev):
    """Devolve a lista de indices agrupados por familia."""
    avg_assets = avg(f["total_assets"], prev.get("total_assets") if prev else None)
    avg_equity = avg(f["equity"], prev.get("equity") if prev else None)
    avg_inventory = avg(f["inventory"], prev.get("inventory") if prev else None)
    avg_receivables = avg(f["accounts_receivable"],
                          prev.get("accounts_receivable") if prev else None)

    liquidez_imediata = None
    if f["cash"] is not None:
        liquidez_imediata = f["cash"] + (f["short_term_investments"] or 0)

    ativo_rapido = None
    if f["current_assets"] is not None and f["inventory"] is not None:
        ativo_rapido = f["current_assets"] - f["inventory"]

    servico_divida = None
    if f["principal"] is not None or f["interest"] is not None:
        servico_divida = (f["principal"] or 0) + (f["interest"] or 0)
    elif f["interest_expense"] is not None:
        servico_divida = f["interest_expense"]

    peg = None
    pe = div(f["share_price"], f["eps"])
    if pe is not None and f["eps_growth_pct"] not in (None, 0):
        peg = pe / f["eps_growth_pct"]

    return [
        ("Rentabilidade", [
            ("roe", "ROE", div(f["net_income"], avg_equity), "pct",
             "Lucro liquido / Patrimonio liquido"),
            ("roa", "ROA", div(f["net_income"], avg_assets), "pct",
             "Lucro liquido / Ativo total"),
            ("margem_bruta", "Margem bruta", div(f["gross_profit"], f["revenue"]), "pct",
             "Lucro bruto / Receita"),
            ("margem_operacional", "Margem operacional",
             div(f["operating_income"], f["revenue"]), "pct",
             "Lucro operacional / Receita"),
            ("margem_liquida", "Margem liquida", div(f["net_income"], f["revenue"]), "pct",
             "Lucro liquido / Receita"),
        ]),
        ("Liquidez", [
            ("liquidez_corrente", "Liquidez corrente",
             div(f["current_assets"], f["current_liabilities"]), "x",
             "Ativo circulante / Passivo circulante"),
            ("liquidez_seca", "Liquidez seca (rapida)",
             div(ativo_rapido, f["current_liabilities"]), "x",
             "(Ativo circulante - Estoques) / Passivo circulante"),
            ("liquidez_caixa", "Liquidez de caixa",
             div(liquidez_imediata, f["current_liabilities"]), "x",
             "(Caixa + Aplicacoes) / Passivo circulante"),
        ]),
        ("Alavancagem", [
            ("divida_pl", "Divida / Patrimonio liquido",
             div(f["total_debt"], f["equity"]), "x", "Divida total / Patrimonio liquido"),
            ("cobertura_juros", "Cobertura de juros",
             div(f["operating_income"], f["interest_expense"]), "x",
             "Lucro operacional / Despesa de juros"),
            ("dscr", "DSCR", div(f["ebitda"], servico_divida), "x",
             "EBITDA / Servico da divida (principal + juros)"),
        ]),
        ("Eficiencia", [
            ("giro_ativos", "Giro do ativo", div(f["revenue"], avg_assets), "x",
             "Receita / Ativo total"),
            ("giro_estoque", "Giro de estoque", div(f["cogs"], avg_inventory), "x",
             "CMV / Estoque"),
            ("giro_receber", "Giro de contas a receber",
             div(f["revenue"], avg_receivables), "x", "Receita / Contas a receber"),
            ("dso", "DSO (prazo medio de recebimento)",
             div(avg_receivables, div(f["revenue"], 365)), "dias",
             "Contas a receber / (Receita / 365)"),
        ]),
        ("Avaliacao", [
            ("pe", "P/L (P/E)", pe, "x", "Preco da acao / LPA"),
            ("pb", "P/VP (P/B)", div(f["market_cap"], f["equity"]), "x",
             "Valor de mercado / Patrimonio liquido"),
            ("ps", "P/Receita (P/S)", div(f["market_cap"], f["revenue"]), "x",
             "Valor de mercado / Receita"),
            ("ev_ebitda", "EV/EBITDA", div(f["enterprise_value"], f["ebitda"]), "x",
             "(Valor de mercado + Divida - Caixa) / EBITDA"),
            ("peg", "PEG", peg, "x", "P/L / crescimento do LPA (%)"),
        ]),
    ]


# --------------------------------------------------------------------------
# Leitura integrada entre familias
# --------------------------------------------------------------------------

def integrated_reading(flat):
    """Cruza familias: e aqui que a analise deixa de ser uma lista de contas.

    Cada regra so dispara quando os dois indices existem, para nao afirmar nada
    sobre dado ausente."""
    v = {k: r["value"] for k, r in flat.items()}
    notes = []

    if v.get("margem_liquida") is not None and v.get("liquidez_corrente") is not None:
        if v["margem_liquida"] >= 0.10 and v["liquidez_corrente"] < 1.0:
            notes.append("Lucrativa, porem apertada de caixa: a margem e boa, mas o "
                         "circulante nao cobre as obrigacoes de curto prazo. Lucro no "
                         "papel nao paga fornecedor.")

    if v.get("divida_pl") is not None and v.get("cobertura_juros") is not None:
        if v["divida_pl"] > 2.0 and v["cobertura_juros"] < 1.5:
            notes.append("Alavancagem em zona de risco: divida alta somada a uma geracao "
                         "operacional que mal cobre os juros. Qualquer queda de receita "
                         "aperta o servico da divida.")
        elif v["divida_pl"] > 1.0 and v["cobertura_juros"] >= 3.0:
            notes.append("Divida elevada, mas confortavelmente servida pelo resultado "
                         "operacional: alavancagem parece deliberada, nao acidental.")

    if v.get("roe") is not None and v.get("roa") is not None and v["roa"] != 0:
        mult = div(v["roe"], v["roa"])
        if mult is not None and mult > 3:
            notes.append("ROE bem acima do ROA (multiplicador de %.1fx): boa parte do "
                         "retorno ao acionista vem de alavancagem, nao da operacao em si."
                         % mult)

    if v.get("margem_liquida") is not None and v.get("giro_ativos") is not None:
        if v["giro_ativos"] >= 1.0 and v["margem_liquida"] < 0.05:
            notes.append("Modelo de giro: margem fina compensada por alto volume. "
                         "Sensivel a queda de vendas e a aumento de custo unitario.")
        elif v["giro_ativos"] < 0.5 and v["margem_liquida"] >= 0.15:
            notes.append("Modelo de margem: gira pouco o ativo, mas ganha bem por venda. "
                         "Sensivel a pressao de preco e a entrada de concorrentes.")

    if v.get("dso") is not None and v.get("liquidez_caixa") is not None:
        if v["dso"] > 75 and v["liquidez_caixa"] < 0.2:
            notes.append("Recebimento lento com caixa curto: o dinheiro esta preso em "
                         "contas a receber. Vale checar inadimplencia e politica de prazo.")

    if v.get("pe") is not None and v.get("roe") is not None:
        if v["pe"] > 25 and v["roe"] < 0.08:
            notes.append("Multiplo alto sem retorno que o sustente: o preco embute um "
                         "crescimento que os numeros atuais ainda nao mostram.")

    if v.get("peg") is not None:
        if 0 < v["peg"] < 1:
            notes.append("PEG abaixo de 1: o preco nao acompanhou o crescimento de lucro "
                         "informado — vale confirmar se esse crescimento e sustentavel.")
        elif v["peg"] > 2:
            notes.append("PEG acima de 2: paga-se caro por cada ponto de crescimento.")

    return notes


def build_assessment(groups, benchmark, previous_ratios):
    flat = {}
    for _, items in groups:
        for key, label, value, unit, formula in items:
            flat[key] = {
                "label": label,
                "value": value,
                "unit": unit,
                "formula": formula,
                "verdict": verdict_for(key, value),
                "benchmark": benchmark.get(key) if benchmark else None,
                "previous": previous_ratios.get(key) if previous_ratios else None,
            }

    fortes, atencao, criticos, faltando = [], [], [], []
    for key, r in flat.items():
        if r["value"] is None:
            faltando.append(r["label"])
        elif r["verdict"] == "good":
            fortes.append(r["label"])
        elif r["verdict"] == "warn":
            atencao.append(r["label"])
        elif r["verdict"] == "bad":
            criticos.append(r["label"])

    return flat, {
        "pontos_fortes": fortes,
        "pontos_de_atencao": atencao,
        "pontos_criticos": criticos,
        "sem_dados": faltando,
        "leitura_integrada": integrated_reading(flat),
    }


# --------------------------------------------------------------------------
# Formatacao
# --------------------------------------------------------------------------

def br(value, decimals=2):
    """Formata numero no padrao brasileiro: milhar com ponto, decimal com virgula."""
    s = "{:,.{d}f}".format(value, d=decimals)
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def fmt(value, unit):
    if value is None:
        return "n/d"
    if unit == "pct":
        return br(value * 100, 1) + "%"
    if unit == "dias":
        return br(value, 0) + " dias"
    return br(value, 2) + "x"


def fmt_delta(value, ref, unit):
    """Diferenca contra benchmark ou periodo anterior, na unidade certa."""
    if value is None or ref is None:
        return ""
    d = value - ref
    sign = "+" if d >= 0 else ""
    if unit == "pct":
        return "%s%s p.p." % (sign, br(d * 100, 1))
    if unit == "dias":
        return "%s%s dias" % (sign, br(d, 0))
    return "%s%sx" % (sign, br(d, 2))


def render_text(data, groups, flat, assessment, used_averages):
    out = []
    nome = data.get("company") or data.get("empresa") or "Empresa"
    periodo = data.get("period") or data.get("periodo") or "periodo nao informado"
    moeda = data.get("currency") or data.get("moeda") or ""

    head = "%s  |  %s" % (nome, periodo)
    if moeda:
        head += "  |  " + moeda
    out.append("=" * 72)
    out.append("  ANALISE DE INDICES FINANCEIROS")
    out.append("  " + head)
    out.append("=" * 72)

    for family, items in groups:
        out.append("")
        out.append(family.upper())
        for key, label, value, unit, _formula in items:
            r = flat[key]
            linha = "  %s %s" % (label.ljust(34, "."), fmt(value, unit).rjust(12))
            if r["verdict"]:
                linha += "  " + VERDICTS[r["verdict"]].ljust(9)
            elif value is not None:
                linha += "  " + "contextual".ljust(9)
            else:
                linha += "  " + " " * 9
            if r["benchmark"] is not None:
                linha += "  setor %s (%s)" % (fmt(r["benchmark"], unit),
                                              fmt_delta(value, r["benchmark"], unit))
            if r["previous"] is not None:
                linha += "  anterior %s (%s)" % (fmt(r["previous"], unit),
                                                 fmt_delta(value, r["previous"], unit))
            out.append(linha)

    out.append("")
    out.append("-" * 72)
    out.append("AVALIACAO INTEGRADA")
    out.append("-" * 72)

    def bloco(titulo, itens):
        if itens:
            out.append("")
            out.append("  " + titulo)
            for i in itens:
                out.append("    - " + i)

    bloco("Pontos fortes:", assessment["pontos_fortes"])
    bloco("Pontos de atencao:", assessment["pontos_de_atencao"])
    bloco("Pontos criticos:", assessment["pontos_criticos"])

    if assessment["leitura_integrada"]:
        out.append("")
        out.append("  Leitura cruzada entre familias:")
        for n in assessment["leitura_integrada"]:
            out.append("    - " + n)
    else:
        out.append("")
        out.append("  Leitura cruzada: nenhum padrao de risco combinado identificado.")

    if assessment["sem_dados"]:
        out.append("")
        out.append("  Sem dados suficientes para calcular:")
        out.append("    " + ", ".join(assessment["sem_dados"]))

    out.append("")
    out.append("-" * 72)
    if not used_averages:
        out.append("Nota: sem 'previous_period' no JSON, indices que pedem saldo medio")
        out.append("(ROE, ROA, giros, DSO) usaram o saldo final do periodo.")
    out.append("Nota: os limites de 'saudavel/atencao/critico' sao referencias gerais.")
    out.append("Multiplos de avaliacao nao recebem nota: P/L baixo tanto pode ser")
    out.append("barganha quanto deterioracao. Compare sempre com o setor.")
    return "\n".join(out)


def build_json(data, flat, assessment, used_averages):
    indices = {}
    for key, r in flat.items():
        indices[key] = {
            "rotulo": r["label"],
            "valor": r["value"],
            "unidade": r["unit"],
            "formula": r["formula"],
            "classificacao": VERDICTS[r["verdict"]] if r["verdict"] else None,
            "benchmark_setor": r["benchmark"],
            "periodo_anterior": r["previous"],
        }
    return {
        "empresa": data.get("company") or data.get("empresa"),
        "periodo": data.get("period") or data.get("periodo"),
        "moeda": data.get("currency") or data.get("moeda"),
        "saldos_medios_utilizados": used_averages,
        "indices": indices,
        "avaliacao": assessment,
    }


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Calcula e interpreta indices financeiros de uma empresa.")
    ap.add_argument("arquivo", help="JSON com as demonstracoes (ver SKILL.md)")
    ap.add_argument("--format", choices=["text", "json"], default="text",
                    help="text (padrao) para relatorio legivel, json para consumo por outra ferramenta")
    args = ap.parse_args()

    try:
        with open(args.arquivo, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        sys.stderr.write("Arquivo nao encontrado: %s\n" % args.arquivo)
        return 1
    except json.JSONDecodeError as e:
        sys.stderr.write("JSON invalido em %s: %s\n" % (args.arquivo, e))
        return 1

    if not isinstance(data, dict):
        sys.stderr.write("O JSON precisa ser um objeto no topo.\n")
        return 1

    atual = read_statements(data)

    prev_raw = data.get("previous_period") or data.get("periodo_anterior")
    prev = read_statements(prev_raw) if isinstance(prev_raw, dict) else None
    used_averages = prev is not None

    benchmark = data.get("benchmark") or data.get("setor") or {}
    if not isinstance(benchmark, dict):
        benchmark = {}

    previous_ratios = {}
    if prev:
        for _, items in compute_ratios(prev, None):
            for key, _l, value, _u, _f in items:
                previous_ratios[key] = value

    groups = compute_ratios(atual, prev)
    flat, assessment = build_assessment(groups, benchmark, previous_ratios)

    if args.format == "json":
        print(json.dumps(build_json(data, flat, assessment, used_averages),
                         ensure_ascii=False, indent=2))
    else:
        print(render_text(data, groups, flat, assessment, used_averages))
    return 0


if __name__ == "__main__":
    sys.exit(main())
