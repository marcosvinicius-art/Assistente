# Assinatura do Wonner Sols (Mercado Pago)

Como funciona para o cliente:

- Ao se cadastrar, ganha o **teste grátis** (7 dias por padrão — editável no painel).
- No topo do app aparece **"Teste: N dias"**; tocando, ele escolhe **Mensal** ou **Anual** e paga:
  - **No cartão**: assinatura que renova sozinha. Se assinar durante o teste, a 1ª cobrança só acontece quando o teste acaba.
  - **No Pix**: paga um período (1 mês ou 1 ano). Para continuar depois, paga de novo ou passa para o cartão.
- Acabou o teste (ou o período pago) sem pagamento: ele **continua vendo** tudo o que lançou, mas **não lança** até assinar. Vale também pelo WhatsApp.
- Contas que já existiam antes da assinatura ficam como **cortesia** (não pagam). Você muda isso cliente a cliente no painel.

Enquanto a credencial do Mercado Pago não estiver na Vercel, os botões de pagar mostram
"pagamentos ainda sendo ligados" e ninguém é cobrado.

## 1. Credenciais

1. Entre em **mercadopago.com.br/developers** → **Suas integrações** → **Criar aplicação**
   (produto: pagamentos online / assinaturas).
2. Em **Credenciais de produção**, copie o **Access Token** (começa com `APP_USR-`).
   Para testar sem dinheiro de verdade, use primeiro as **credenciais de teste** e os usuários de teste do MP.

## 2. Variáveis na Vercel

Projeto → **Settings → Environment Variables**:

| Variável | Valor |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | o Access Token |
| `MERCADOPAGO_WEBHOOK_SECRET` | a "assinatura secreta" do passo 3 |
| `SITE_URL` | o endereço do site, ex.: `https://wonnersols.vercel.app` (sem barra no fim) |

Depois: **Deployments → ⋯ → Redeploy**.

## 3. Webhooks (o Mercado Pago avisa o site quando alguém paga)

1. Na sua aplicação do MP: **Webhooks → Configurar notificações**.
2. **URL de produção**: `https://SEU-SITE/api/pagamentos?acao=webhook`
3. Eventos: marque **Pagamentos** e **Planos e assinaturas** (assinaturas e pagamentos autorizados).
4. Salve e copie a **assinatura secreta** gerada → `MERCADOPAGO_WEBHOOK_SECRET` na Vercel (e reimplante).

Mesmo com o aviso assinado, o site nunca libera acesso pelo conteúdo do aviso: ele consulta o
pagamento/assinatura na API do Mercado Pago com o seu token antes de liberar.

## 4. Preços e regras (no painel do app)

Aba **Administração → Recursos do site**:

- **Assinatura**: preço mensal, anual e dias grátis. Valem para novas assinaturas
  (quem já assina no cartão continua no valor que contratou).
- **Aprovar cada cadastro manualmente**: ligado (padrão), conta nova espera você liberar e o
  teste começa ao liberar. Desligado, o cliente entra na hora e o teste já começa — o fluxo normal de SaaS.

Na lista de **Clientes**, cada um mostra a situação (`teste · 4d`, `mensal`, `anual · pix`, `cortesia`, `sem plano`)
e o seletor **Acesso…** para dar cortesia, tirar cortesia ou dar mais dias grátis.

## 5. Testar antes de ir para produção

1. Coloque as **credenciais de teste** na Vercel.
2. Crie uma conta de cliente no app e toque em **Assinar**.
3. Pague com os cartões de teste do Mercado Pago (lista na documentação deles) ou com um usuário de teste.
4. Em alguns segundos o topo muda para **"Plano mensal"** e o cliente volta a lançar.
5. Tudo certo: troque para as credenciais de produção e reimplante.

## Problemas comuns

- **Pagou e não liberou** → o webhook não está chegando: confira a URL do passo 3 e os eventos marcados.
  Nos logs da Vercel, procure por `pagamentos/webhook`.
- **Logs mostram `assinatura_invalida`** → `MERCADOPAGO_WEBHOOK_SECRET` diferente da assinatura secreta do painel do MP.
- **"Não consegui falar com o Mercado Pago"** ao assinar → Access Token errado ou de outra conta.
- **Pix pago e não liberou** → o valor pago foi menor que o do pedido (o site não libera pagamento a menos).
