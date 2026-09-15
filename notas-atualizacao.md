# Contas em Dia — Notas de atualização

Arquivo principal: `contas-em-dia.html`
Link publicado: https://claude.ai/code/artifact/2b0e6106-6216-463f-a9cc-ebc4b977806c

## 1. Painel inicial
- Aba **Lançamentos**: receitas e despesas do mês, categorias, saldo, taxa de poupança.
- Campo de **salário do mês** com atualização automática (não duplica lançamento).
- Preview do valor digitado ("= R$ X,XX") pra não confundir 300 com 3.000.
- Gráfico de **evolução mensal** (receitas x despesas, últimos 6 meses).
- Exportar lançamentos em **CSV**.
- Dados salvos na nuvem, vinculados à conta Claude (sincroniza entre computador e celular).

## 2. Investimentos & Metas
- Nova aba com:
  - **Investimentos**: valor investido, valor atual, rendimento em R$ e % (alta/baixa), dividendos recebidos.
  - Edição completa de investimentos (descrição, valor, tipo, data).
  - **Metas de economia**: aportes, barra de progresso.
  - Card **"Quanto você pode gastar este mês"** (considera receitas, dividendos, despesas e investimentos do mês) — também replicado na aba Lançamentos.
- Correção de bug: as barras de progresso (metas e categorias) não preenchiam visualmente por causa de um erro de CSS.

## 3. Assistente (chat + voz)
- Nova aba **Assistente**: manda um gasto/receita/investimento/dividendo por texto ou voz (microfone) e ele já lança.
- Funciona em dois modos:
  - **Com IA** (quando disponível na conta): entende frases livres.
  - **Modo simples** (sempre disponível, sem depender de IA): reconhece frases como "gastei 45 no mercado", "recebi salário de 4200", "caiu 20 de dividendo do Tesouro Selic".
- Ditado por voz via microfone do navegador (pode não funcionar em todo navegador/ambiente — cai automaticamente pra digitação).

## 4. Visual
- Ícones próprios (SVG) no lugar de emojis/caracteres.
- Marca (logo) ao lado do nome do app.
- Tipografia com itálico na fonte de título (Fraunces), mais elegante.
- Transições suaves, foco nos campos mais visível, scrollbar customizada.

## 5. Acesso pelo celular
- Botão **"No celular"** no topo: abre um **QR code** com o link fixo e correto do site (`https://claude.ai/code/artifact/2b0e6106-6216-463f-a9cc-ebc4b977806c`).
- Pra manter logado no celular: abrir no navegador principal (não no navegador interno do WhatsApp/Instagram), fazer login uma vez, e usar "Adicionar à tela de início" pra abrir como app.

## Pendências / decisões em aberto
- O site depende de login na conta Claude (marcos.vinicius@useebrasil.com.br) pra sincronizar dados — não existe hoje uma versão 100% sem login com sincronização entre aparelhos.
- O link ainda não abre automaticamente dentro do app do Claude no celular (abre no navegador) — isso depende do próprio app do Claude, não do site.
