#!/usr/bin/env python3
"""Compara orcado x realizado, classifica os desvios e aponta onde o orcamento estourou.

Uso:
    python budget_variance_analyzer.py budget_data.json
    python budget_variance_analyzer.py budget_data.json --format json

Somente biblioteca padrao. O JSON de entrada esta documentado no SKILL.md e ha um
exemplo completo em examples/budget_data.json.
"""

import argparse
import json
import sys

try:  # console do Windows costuma vir em cp1252 e quebra os acentos do relatorio
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# Linhas de receita e de custo se comportam de forma oposta: realizar acima do
# orcado e bom na receita e ruim na despesa. Esse mapa e o que evita somar
# "desvios" que na verdade se cancelam.
REVENUE_TYPES = {"revenue", "receita", "receitas", "entrada", "income"}
EXPENSE_TYPES = {"expense", "cost", "despesa", "despesas", "custo", "custos", "saida"}

DEFAULT_MATERIALITY_PCT = 5.0


def num(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k]
    return None


def br(value, decimals=2):
    """Numero no padrao brasileiro: milhar com ponto, decimal com virgula."""
    if value is None:
        return "n/d"
    s = "{:,.{d}f}".format(value, d=decimals)
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def money(value, currency=""):
    if value is None:
        return "n/d"
    txt = br(value, 2)
    return (currency + " " + txt).strip() if currency else txt


def pct(value):
    if value is None:
        return "n/d"
    sign = "+" if value >= 0 else ""
    return "%s%s%%" % (sign, br(value, 1))


# --------------------------------------------------------------------------

def classify(kind):
    k = (kind or "expense").strip().lower()
    if k in REVENUE_TYPES:
        return "revenue"
    if k in EXPENSE_TYPES:
        return "expense"
    return "expense"


def analyze_line(item, materiality_pct, materiality_abs):
    name = first(item, "name", "nome", "linha") or "(sem nome)"
    kind = classify(first(item, "type", "tipo", "natureza"))
    group = first(item, "group", "grupo", "categoria") or "Geral"
    budget = num(first(item, "budget", "orcado", "previsto"))
    actual = num(first(item, "actual", "realizado", "real"))

    if budget is None and actual is None:
        return None

    budget = budget or 0.0
    actual = actual or 0.0
    variance = actual - budget

    # Sem orcamento nao existe percentual de desvio; a linha vira "nao orcada",
    # que e uma informacao em si e nao um erro.
    variance_pct = None
    unbudgeted = budget == 0
    if not unbudgeted:
        variance_pct = variance / abs(budget) * 100.0

    if kind == "revenue":
        favorable = variance >= 0
    else:
        favorable = variance <= 0

    impact = abs(variance)
    material = impact >= materiality_abs if materiality_abs else False
    if variance_pct is not None and abs(variance_pct) >= materiality_pct:
        material = True
    if unbudgeted and impact > 0:
        material = True

    return {
        "nome": name,
        "natureza": kind,
        "grupo": group,
        "orcado": budget,
        "realizado": actual,
        "desvio": variance,
        "desvio_pct": variance_pct,
        "favoravel": favorable,
        "relevante": material,
        "nao_orcada": unbudgeted and actual != 0,
        "impacto": impact,
    }


def summarize(lines):
    rev_b = sum(l["orcado"] for l in lines if l["natureza"] == "revenue")
    rev_a = sum(l["realizado"] for l in lines if l["natureza"] == "revenue")
    exp_b = sum(l["orcado"] for l in lines if l["natureza"] == "expense")
    exp_a = sum(l["realizado"] for l in lines if l["natureza"] == "expense")

    res_b = rev_b - exp_b
    res_a = rev_a - exp_a

    def dpct(a, b):
        return None if b == 0 else (a - b) / abs(b) * 100.0

    return {
        "receita": {"orcado": rev_b, "realizado": rev_a, "desvio": rev_a - rev_b,
                    "desvio_pct": dpct(rev_a, rev_b)},
        "despesa": {"orcado": exp_b, "realizado": exp_a, "desvio": exp_a - exp_b,
                    "desvio_pct": dpct(exp_a, exp_b)},
        "resultado": {"orcado": res_b, "realizado": res_a, "desvio": res_a - res_b,
                      "desvio_pct": dpct(res_a, res_b)},
    }


def group_totals(lines):
    grupos = {}
    for l in lines:
        g = grupos.setdefault(l["grupo"], {
            "grupo": l["grupo"], "orcado": 0.0, "realizado": 0.0, "desvio": 0.0,
        })
        g["orcado"] += l["orcado"]
        g["realizado"] += l["realizado"]
        g["desvio"] += l["desvio"]
    saida = list(grupos.values())
    for g in saida:
        g["desvio_pct"] = None if g["orcado"] == 0 else g["desvio"] / abs(g["orcado"]) * 100.0
    saida.sort(key=lambda g: abs(g["desvio"]), reverse=True)
    return saida


def build_findings(lines, resumo):
    desfavoraveis = [l for l in lines if not l["favoravel"] and l["impacto"] > 0]
    desfavoraveis.sort(key=lambda l: l["impacto"], reverse=True)
    favoraveis = [l for l in lines if l["favoravel"] and l["impacto"] > 0]
    favoraveis.sort(key=lambda l: l["impacto"], reverse=True)
    nao_orcadas = [l for l in lines if l["nao_orcada"]]

    leitura = []
    res = resumo["resultado"]
    rec = resumo["receita"]
    desp = resumo["despesa"]

    if res["desvio"] < 0:
        causa = []
        if rec["desvio"] < 0:
            causa.append("receita abaixo do previsto (%s)" % money(rec["desvio"]))
        if desp["desvio"] > 0:
            causa.append("despesa acima do previsto (%s)" % money(desp["desvio"]))
        if causa:
            leitura.append("Resultado ficou %s abaixo do orcado, puxado por %s."
                           % (money(abs(res["desvio"])), " e ".join(causa)))
        else:
            leitura.append("Resultado ficou abaixo do orcado.")
    elif res["desvio"] > 0:
        leitura.append("Resultado superou o orcado em %s." % money(res["desvio"]))
    else:
        leitura.append("Resultado fechou exatamente no orcado.")

    # Caso classico que passa batido num relatorio so de totais: o resultado parece
    # ok porque um corte de despesa esconde uma frustracao de receita.
    if rec["desvio"] < 0 and desp["desvio"] < 0 and res["desvio"] >= 0:
        leitura.append("Atencao: o resultado so se sustentou porque a despesa tambem "
                       "ficou abaixo do previsto. A receita frustrou, e cortar gasto "
                       "costuma ter limite - a frustracao de receita tende a aparecer "
                       "no resultado nos proximos periodos.")

    if rec["desvio_pct"] is not None and rec["desvio_pct"] <= -10:
        leitura.append("Receita %s abaixo do orcado: desvio dessa ordem geralmente "
                       "indica premissa de venda irreal ou perda de demanda, nao "
                       "flutuacao normal." % pct(rec["desvio_pct"]))

    if nao_orcadas:
        total_nao_orcado = sum(l["realizado"] for l in nao_orcadas)
        leitura.append("Ha %d linha(s) realizada(s) sem previsao no orcamento, somando "
                       "%s. Gasto fora do orcamento e o que mais corroi previsibilidade."
                       % (len(nao_orcadas), money(total_nao_orcado)))

    concentracao = None
    total_desfav = sum(l["impacto"] for l in desfavoraveis)
    if desfavoraveis and total_desfav > 0:
        topo = desfavoraveis[0]
        parte = topo["impacto"] / total_desfav * 100.0
        if parte >= 50:
            concentracao = ("%s concentra %s de todo o desvio desfavoravel: tratar essa "
                            "linha resolve a maior parte do problema."
                            % (topo["nome"], pct(parte).lstrip("+")))
            leitura.append(concentracao)

    return {
        "maiores_desvios_desfavoraveis": desfavoraveis[:5],
        "maiores_desvios_favoraveis": favoraveis[:5],
        "linhas_nao_orcadas": nao_orcadas,
        "leitura": leitura,
    }


# --------------------------------------------------------------------------

def render_text(data, lines, resumo, grupos, findings, materiality_pct, currency):
    out = []
    nome = first(data, "entity", "empresa", "entidade") or "Orcamento"
    periodo = first(data, "period", "periodo") or "periodo nao informado"

    out.append("=" * 76)
    out.append("  ANALISE DE VARIACAO ORCAMENTARIA")
    out.append("  %s  |  %s" % (nome, periodo))
    out.append("=" * 76)

    out.append("")
    out.append("RESUMO")
    for rotulo, chave in (("Receita", "receita"), ("Despesa", "despesa"),
                          ("Resultado", "resultado")):
        b = resumo[chave]
        out.append("  %s orcado %s   realizado %s   desvio %s (%s)" % (
            rotulo.ljust(10),
            money(b["orcado"], currency).rjust(16),
            money(b["realizado"], currency).rjust(16),
            money(b["desvio"], currency).rjust(16),
            pct(b["desvio_pct"])))

    out.append("")
    out.append("LINHAS  (F = favoravel, D = desfavoravel, * = relevante)")
    out.append("   %s %s %s %s %s" % (
        "Linha".ljust(26), "Orcado".rjust(14), "Realizado".rjust(14),
        "Desvio".rjust(14), "%".rjust(8)))
    for l in sorted(lines, key=lambda x: abs(x["desvio"]), reverse=True):
        marca = "F" if l["favoravel"] else "D"
        rel = "*" if l["relevante"] else " "
        rotulo = l["nome"]
        if l["nao_orcada"]:
            rotulo += " (nao orcada)"
        out.append("%s%s %s %s %s %s %s" % (
            marca, rel,
            rotulo[:26].ljust(26),
            money(l["orcado"], "").rjust(14),
            money(l["realizado"], "").rjust(14),
            money(l["desvio"], "").rjust(14),
            pct(l["desvio_pct"]).rjust(8)))

    if len(grupos) > 1:
        out.append("")
        out.append("POR GRUPO")
        for g in grupos:
            out.append("  %s desvio %s (%s)" % (
                g["grupo"][:26].ljust(26),
                money(g["desvio"], currency).rjust(16),
                pct(g["desvio_pct"])))

    out.append("")
    out.append("-" * 76)
    out.append("AVALIACAO INTEGRADA")
    out.append("-" * 76)
    for nota in findings["leitura"]:
        out.append("  - " + nota)

    if findings["maiores_desvios_desfavoraveis"]:
        out.append("")
        out.append("  Onde o orcamento estourou (maior impacto primeiro):")
        for l in findings["maiores_desvios_desfavoraveis"]:
            out.append("    %s  %s (%s)" % (
                l["nome"][:30].ljust(30), money(l["desvio"], currency),
                pct(l["desvio_pct"])))

    if findings["maiores_desvios_favoraveis"]:
        out.append("")
        out.append("  Onde sobrou:")
        for l in findings["maiores_desvios_favoraveis"]:
            out.append("    %s  %s (%s)" % (
                l["nome"][:30].ljust(30), money(l["desvio"], currency),
                pct(l["desvio_pct"])))

    out.append("")
    out.append("-" * 76)
    out.append("Relevancia: desvio marcado com * passa de %s%% do orcado da linha"
               % br(materiality_pct, 1))
    out.append("(ou do valor absoluto definido em 'materiality'). Linha sem orcamento")
    out.append("nao tem percentual, entao e sempre marcada como relevante.")
    return "\n".join(out)


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Compara orcado x realizado e aponta os desvios relevantes.")
    ap.add_argument("arquivo", help="JSON com o orcamento (ver SKILL.md)")
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

    raw_lines = first(data, "line_items", "linhas", "itens")
    if not isinstance(raw_lines, list) or not raw_lines:
        sys.stderr.write("Nenhuma linha encontrada: esperava 'line_items' como lista.\n")
        return 1

    mat = data.get("materiality") or data.get("relevancia") or {}
    materiality_pct = num(first(mat, "pct", "percentual")) or DEFAULT_MATERIALITY_PCT
    materiality_abs = num(first(mat, "abs", "absoluto")) or 0.0
    currency = first(data, "currency", "moeda") or ""

    lines = []
    for item in raw_lines:
        if not isinstance(item, dict):
            continue
        parsed = analyze_line(item, materiality_pct, materiality_abs)
        if parsed:
            lines.append(parsed)

    if not lines:
        sys.stderr.write("Nenhuma linha valida: cada item precisa de 'budget' ou 'actual'.\n")
        return 1

    resumo = summarize(lines)
    grupos = group_totals(lines)
    findings = build_findings(lines, resumo)

    if args.format == "json":
        print(json.dumps({
            "entidade": first(data, "entity", "empresa", "entidade"),
            "periodo": first(data, "period", "periodo"),
            "moeda": currency,
            "relevancia_pct": materiality_pct,
            "resumo": resumo,
            "linhas": lines,
            "grupos": grupos,
            "avaliacao": findings,
        }, ensure_ascii=False, indent=2))
    else:
        print(render_text(data, lines, resumo, grupos, findings, materiality_pct, currency))
    return 0


if __name__ == "__main__":
    sys.exit(main())
