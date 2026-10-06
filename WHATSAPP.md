# Agente do Wonner Sols no WhatsApp

O cliente conversa com um número de WhatsApp do Wonner Sols e o agente mexe na
conta dele: lança gastos e entradas, responde resumo/parcelas/últimos, desfaz o
último lançamento e guarda a foto da nota como comprovante. Cobranças e avisos
individuais do painel também chegam no WhatsApp do cliente conectado.

O código já está no projeto (`api/whatsapp.js`, `api/_agente.js`, `api/_whatsapp.js`).
Enquanto as variáveis abaixo não existirem, o agente fica desligado e o botão
**WhatsApp** não aparece no app.

> Os nomes dos menus da Meta mudam de tempos em tempos. Se algo não estiver
> exatamente onde está escrito aqui, procure pelo nome do item na busca do painel.

## 1. Criar o app na Meta (grátis, com número de teste)

1. Entre em **developers.facebook.com** → **My Apps → Create App**.
2. Tipo de uso: **Business** (ou "Outro" → "Empresa"). Ligue o app à sua conta Meta Business
   (ou crie uma quando ele pedir).
3. No app criado, adicione o produto **WhatsApp** → **Set up**.
4. Em **WhatsApp → API Setup** a Meta já dá um **número de teste**. Anote:
   - **Phone number ID** (não é o número em si, é um ID longo)
   - **Temporary access token** (vale 24 horas — serve só para o primeiro teste)
5. Ainda em API Setup, em **To**, adicione o **seu** WhatsApp como destinatário de teste
   (o número de teste só conversa com até 5 números cadastrados ali).
6. Em **App settings → Basic**, copie o **App secret** (clique em "Show").

## 2. Variáveis na Vercel

Projeto na Vercel → **Settings → Environment Variables**:

| Variável | Valor |
|---|---|
| `WHATSAPP_TOKEN` | o token (o temporário para testar; depois o permanente, passo 5) |
| `WHATSAPP_PHONE_ID` | o Phone number ID |
| `WHATSAPP_APP_SECRET` | o App secret |
| `WHATSAPP_VERIFY_TOKEN` | um texto qualquer que você inventa, ex.: `wonner-verifica-2026` |
| `WHATSAPP_NUMERO` | o número do agente só com dígitos, com país e DDD, ex.: `5511999998888` |

Depois: **Deployments → ⋯ → Redeploy** (variável nova só vale após reimplantar).

## 3. Ligar o webhook (a Meta avisa o site a cada mensagem)

1. Na Meta: **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL**: `https://SEU-SITE.vercel.app/api/whatsapp`
3. **Verify token**: exatamente o mesmo texto de `WHATSAPP_VERIFY_TOKEN`.
4. **Verify and save**. Se der erro, o texto não bate ou o redeploy não terminou.
5. Em **Webhook fields**, assine o campo **messages**.

## 4. Testar

1. Entre no app com uma conta de cliente → botão **WhatsApp** no topo → **Gerar código**.
2. Toque em **Abrir no WhatsApp** (abre a conversa com o código escrito) e envie.
3. O agente responde "Pronto! Este WhatsApp está conectado…". Teste:
   `gastei 45 no mercado`, `resumo`, `parcelas`, `desfazer`, uma foto de nota.

## 5. Ir para produção (número de verdade)

1. **Token permanente**: em **business.facebook.com → Configurações → Usuários do sistema**,
   crie um usuário do sistema (Admin), dê acesso ao app e gere um token com as permissões
   `whatsapp_business_messaging` e `whatsapp_business_management`. Troque `WHATSAPP_TOKEN`
   por ele e reimplante. O temporário para de funcionar em 24h.
2. **Verificação da empresa** (Meta Business → Central de segurança): pede CNPJ e documentos.
3. **Número próprio**: em **WhatsApp → API Setup → Add phone number**. O número **não pode
   estar em uso no app comum do WhatsApp** (nem no WhatsApp Business do celular).
   Troque `WHATSAPP_PHONE_ID` e `WHATSAPP_NUMERO` pelos do número novo.
4. **Forma de pagamento** na conta do WhatsApp Business (a Meta cobra por mensagem).

## 6. Cobranças e avisos fora das 24h (modelos)

O WhatsApp só deixa a **empresa puxar conversa** com um **modelo aprovado** quando já
passaram 24h desde a última mensagem do cliente. Sem modelo, a cobrança enviada pelo
painel só chega para quem falou com o agente nas últimas 24h — o painel avisa quando isso
acontecer ("fora da janela de 24h").

Para resolver, crie dois modelos em **WhatsApp Manager → Modelos de mensagem**
(categoria **Utilidade**, idioma **Português (BR)**):

- **cobranca** — texto, por exemplo:
  `Olá! Você tem uma cobrança do Wonner Sols de {{1}}, com vencimento em {{2}}. Abra o app para ver a chave Pix e pagar.`
- **aviso** — texto: `Aviso do Wonner Sols: {{1}}`

Depois de aprovados, adicione na Vercel e reimplante:

| Variável | Valor |
|---|---|
| `WHATSAPP_TEMPLATE_COBRANCA` | nome exato do modelo, ex.: `cobranca` |
| `WHATSAPP_TEMPLATE_AVISO` | nome exato do modelo, ex.: `aviso` |

## Custos

- Respostas do agente a mensagens que o **cliente** mandou: hoje a Meta não cobra as
  mensagens de atendimento dentro das 24h após o cliente escrever.
- Mensagens que a **empresa** inicia (os modelos de cobrança/aviso) são cobradas por
  mensagem, com preço por país e categoria. Confira a tabela atual na página de preços
  do WhatsApp Business Platform antes de ligar os modelos.
- O agente não usa IA, então não há custo de IA.

## O que o agente entende

- Lançar: `gastei 45 no mercado`, `paguei 120 de luz ontem`, `comprei celular 600 em 3x no nubank`,
  `recebi 3000 de salário`, datas como `ontem`, `anteontem`, `dia 3`, `03/10`.
  Cartão: escreva o nome de um cartão cadastrado no app. Parcelas: `em 3x` / `em 3 vezes`.
- Foto ou PDF da nota: com o valor na legenda já lança; sem, o agente pergunta o valor.
- `resumo` (ou `resumo setembro`), `parcelas`, `últimos`, `desfazer`, `ajuda`, `desconectar`.
- Investimentos, metas e dividendos continuam só pelo app.

## Problemas comuns

- **Webhook não salva na Meta** → `WHATSAPP_VERIFY_TOKEN` diferente do digitado, ou faltou o redeploy.
- **O agente não responde** → token vencido (o temporário dura 24h), campo **messages** não
  assinado, ou o seu número não está entre os destinatários de teste.
- **Logs da Vercel mostram "assinatura não confere"** → `WHATSAPP_APP_SECRET` errado.
- **Cobrança não chega no WhatsApp** → o painel mostra o motivo logo abaixo do botão.
