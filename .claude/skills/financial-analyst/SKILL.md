---
name: financial-analyst
description: Analise financeira de empresas a partir de demonstracoes e de orcamentos. Calcula e interpreta indices de rentabilidade (ROE, ROA, margens), liquidez (corrente, seca, caixa), alavancagem (Divida/PL, cobertura de juros, DSCR), eficiencia (giros, DSO) e avaliacao (P/L, P/VP, P/Receita, EV/EBITDA, PEG), alem de variacao orcamentaria (orcado x realizado). Use quando pedirem analise fundamentalista, indices financeiros, saude financeira de uma empresa, leitura de balanco/DRE, ou comparacao entre orcado e realizado.
---

# Analista financeiro

Duas ferramentas de linha de comando, sem dependencias externas (so biblioteca padrao
do Python 3). Cada uma le um JSON e imprime um relatorio legivel, ou JSON estruturado
com `--format json` para encadear com outra ferramenta.

## 1. Indices financeiros

```bash
python .claude/skills/financial-analyst/scripts/ratio_calculator.py financial_data.json
python .claude/skills/financial-analyst/scripts/ratio_calculator.py financial_data.json --format json
```

Calcula cinco familias de indices e faz a leitura cruzada entre elas:

| Familia | Indices |
|---|---|
| Rentabilidade | ROE, ROA, margem bruta, margem operacional, margem liquida |
| Liquidez | corrente, seca (rapida), de caixa |
| Alavancagem | Divida/PL, cobertura de juros, DSCR |
| Eficiencia | giro do ativo, giro de estoque, giro de contas a receber, DSO |
| Avaliacao | P/L, P/VP, P/Receita, EV/EBITDA, PEG |

### Entrada

Exemplo completo em `examples/financial_data.json`. Chaves em ingles (padrao) ou em
portugues (`receita_liquida`, `lucro_liquido`, `patrimonio_liquido`, ...) — o script
aceita os dois.

```json
{
  "company": "...", "period": "2025", "currency": "BRL",
  "income_statement": {
    "revenue": 0, "cogs": 0, "operating_expenses": 0,
    "depreciation_amortization": 0, "interest_expense": 0, "net_income": 0
  },
  "balance_sheet": {
    "cash": 0, "short_term_investments": 0, "accounts_receivable": 0,
    "inventory": 0, "current_assets": 0, "total_assets": 0,
    "current_liabilities": 0, "total_debt": 0, "total_liabilities": 0, "equity": 0
  },
  "market": { "share_price": 0, "shares_outstanding": 0, "eps_growth_pct": 0 },
  "debt_service": { "principal": 0, "interest": 0 },
  "previous_period": { "income_statement": {}, "balance_sheet": {} },
  "benchmark": { "roe": 0, "dso": 0 }
}
```

Tres blocos sao opcionais e cada um acrescenta uma camada de analise:

- **`previous_period`** — liga o calculo por **saldo medio** (o correto para ROE, ROA,
  giros e DSO) e a comparacao com o periodo anterior. Sem ele, o script usa o saldo
  final e avisa isso no rodape.
- **`benchmark`** — medianas do setor, pelas chaves de indice (`roe`, `dso`, `pe`...).
  Sempre que existir, prevalece sobre os limites genericos na interpretacao.
- **`debt_service`** — principal + juros do periodo, necessario para o DSCR. Sem ele,
  o DSCR cai para a despesa de juros apenas.

O que faltar vira `n/d` em vez de erro: o script calcula tudo que os dados permitem e
lista no fim o que ficou sem dado.

### Derivacoes automaticas

Nao repita o que da para deduzir: lucro bruto (`revenue - cogs`), lucro operacional
(`gross_profit - operating_expenses`), EBITDA (`operating_income + depreciacao`),
patrimonio liquido (`total_assets - total_liabilities`), valor de mercado
(`share_price x shares_outstanding`) e EV (`valor de mercado + divida - caixa`).

## 2. Variacao orcamentaria

```bash
python .claude/skills/financial-analyst/scripts/budget_variance_analyzer.py budget_data.json
python .claude/skills/financial-analyst/scripts/budget_variance_analyzer.py budget_data.json --format json
```

Compara orcado x realizado linha a linha, por grupo e no resultado final.

### Entrada

Exemplo completo em `examples/budget_data.json`.

```json
{
  "entity": "...", "period": "2025-09", "currency": "R$",
  "materiality": { "pct": 5, "abs": 10000 },
  "line_items": [
    { "name": "Receita de servicos", "type": "revenue", "group": "Receita",
      "budget": 520000, "actual": 468000 },
    { "name": "Folha", "type": "expense", "group": "Pessoal",
      "budget": 260000, "actual": 274000 }
  ]
}
```

O campo **`type`** e o mais importante: define o sinal do desvio. Numa linha de
`revenue`, realizar acima do orcado e **favoravel**; numa de `expense`, e
**desfavoravel**. Sem isso, desvios de naturezas opostas se cancelariam e o relatorio
mentiria. Quando `type` vem ausente, a linha e tratada como despesa.

`group` e opcional e habilita subtotais. `materiality` define o que ganha destaque
(`pct` do orcado da linha, `abs` em valor); o padrao e 5%. Linha com `budget: 0` e
tratada como **nao orcada** — sem percentual, mas sempre relevante.

## Interpretacao

Os dois scripts terminam com uma secao de avaliacao integrada, que e o objetivo da
skill — a lista de contas sozinha nao decide nada.

Nos indices, a leitura cruza familias em vez de olhar cada numero isolado. Alguns
padroes que ele identifica: margem boa com liquidez apertada (lucro que nao vira
caixa), divida alta com cobertura de juros baixa (risco no servico da divida), ROE
muito acima do ROA (retorno vindo de alavancagem, nao da operacao), giro alto com
margem fina versus giro baixo com margem gorda (modelo de volume x modelo de margem).

No orcamento, ele aponta a causa do desvio no resultado (receita frustrada, despesa
estourada ou ambas), destaca o caso em que o resultado so se salvou porque a despesa
tambem ficou abaixo do previsto, e ordena as linhas por impacto.

## Limites — diga isso a quem pedir a analise

- **Os limites de "saudavel/atencao/critico" sao referencias gerais.** O que e divida
  alta num setor e normal em outro. Quando houver `benchmark` do setor, ele manda.
- **Multiplos de avaliacao nao recebem nota.** P/L baixo tanto pode ser barganha
  quanto empresa em deterioracao; o script compara, mas nao classifica.
- **Nada aqui e recomendacao de investimento.** Sao contas sobre os numeros
  fornecidos, e a qualidade da analise depende inteiramente da qualidade do JSON.
- **O script nao busca dados.** Ele nao acessa a internet nem consulta demonstracoes:
  os numeros precisam ser montados no JSON de entrada.
