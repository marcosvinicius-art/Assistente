# E-mails do Wonner Sols (Resend)

O que o site manda por e-mail quando está ligado:

| Quando | E-mail |
|---|---|
| Cliente toca em **Esqueci minha senha** | Link para criar senha nova (vale 1 hora, uso único) |
| Você **libera** uma conta no painel | "Sua conta foi liberada" |
| Você manda uma **cobrança** no painel | A cobrança, com valor, vencimento e chave Pix |
| Falta ~1 dia para o **teste grátis** acabar e o cliente não assinou | "Seu teste grátis acaba amanhã" (uma vez por conta, todo dia às 9h de Brasília) |

**Enquanto não estiver ligado**, nada disso é enviado e o "Esqueci minha senha" continua mostrando
o seu e-mail de contato, como sempre foi. Nada quebra.

## Por que precisa de domínio próprio

E-mail enviado "em nome de" um Gmail ou de um domínio que não é seu cai no spam (ou é recusado).
Com um domínio seu (ex.: `wonnersols.com.br`) e os registros de verificação, os e-mails chegam na caixa de entrada.

## 1. Domínio

Compre um domínio (Registro.br para `.com.br`, ou qualquer registrador). Dá para usar o mesmo domínio
no site: na Vercel, **Settings → Domains → Add**.

## 2. Resend

1. Crie a conta em **resend.com** (plano grátis: 3.000 e-mails/mês, 100 por dia).
2. **Domains → Add Domain** → digite o seu domínio.
3. O Resend mostra alguns registros (SPF, DKIM). Copie-os no painel DNS do seu domínio
   (Registro.br ou onde estiver o DNS). Em algumas horas o Resend marca o domínio como **Verified**.
4. **API Keys → Create API Key** (permissão de envio) e copie a chave (começa com `re_`).

## 3. Variáveis na Vercel

Projeto → **Settings → Environment Variables**:

| Variável | Valor |
|---|---|
| `RESEND_API_KEY` | a chave do Resend |
| `EMAIL_REMETENTE` | `Wonner Sols <nao-responda@seudominio.com.br>` (o domínio tem que ser o verificado) |
| `SITE_URL` | o endereço do site, ex.: `https://wonnersols.com.br` (é para onde os links apontam) |
| `CRON_SECRET` | um texto aleatório longo — protege o lembrete diário (a Vercel o envia sozinha ao agendador) |

Depois: **Deployments → ⋯ → Redeploy**.

## 4. Testar

1. Saia da conta, toque em **Esqueci minha senha** e digite o e-mail de uma conta de cliente.
2. Chega o e-mail "Criar uma senha nova"; o link abre o app direto na tela de senha nova.
3. No painel, libere uma conta de teste ou mande uma cobrança: o e-mail chega para o cliente.

## Problemas comuns

- **Nenhum e-mail chega** → domínio ainda não está **Verified** no Resend, ou `EMAIL_REMETENTE` usa outro domínio.
- **Cai no spam** → faltam registros DNS (SPF/DKIM) do passo 2.
- **Link do e-mail abre o endereço errado** → ajuste `SITE_URL`.
- **Lembrete diário não sai** → falta `CRON_SECRET`; em **Settings → Cron Jobs** a Vercel mostra se ele está rodando.
