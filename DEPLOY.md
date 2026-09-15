# Deploy do Wonner Sols na Vercel (com login de cada cliente)

Passo a passo pra colocar o site no ar com conta própria (email + senha) por cliente.
Cada cliente só vê os próprios dados — nunca os de outro.

## 1. Subir o código pro GitHub

```powershell
cd "C:\Users\Usee Brasil\Downloads\site pra economizar"
git init
git add .
git commit -m "Site com login por cliente"
```

Crie um repositório vazio em github.com/new (pode ser privado) e rode os dois
comandos que o próprio GitHub mostra na tela seguinte (algo como):

```powershell
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git branch -M main
git push -u origin main
```

## 2. Conectar o repositório na Vercel

1. vercel.com → **Add New → Project**
2. Escolha **Import Git Repository** e selecione o repositório que você acabou de criar
3. Não precisa mudar nenhuma configuração de build — clique em **Deploy**

O primeiro deploy provavelmente vai **falhar ou abrir com erro** — é esperado, porque
ainda faltam os dois passos abaixo (banco de dados e chave de sessão).

## 3. Criar o banco de dados

1. No projeto, aba **Storage → Create Database → Postgres**
2. Conecte ao projeto quando perguntado

Isso cria sozinha a variável `POSTGRES_URL` que o backend usa — nenhuma senha de
banco pra copiar manualmente.

## 4. Configurar a chave de sessão

Em **Settings → Environment Variables**, adicione:

- **Name:** `SESSION_SECRET`
- **Value:** (peça uma chave nova ao Claude, ou gere a sua — qualquer string
  aleatória longa serve)

Essa chave assina o cookie de login. Guarde-a como uma senha: quem tiver essa
chave consegue forjar uma sessão de qualquer cliente.

## 5. Reimplantar

Aba **Deployments** → nos "⋯" do último deploy → **Redeploy**.

Agora o site pede email e senha antes de mostrar qualquer coisa. Crie sua própria
conta clicando em "Não tem conta? Criar uma".

## Quando editar o app depois

O arquivo fonte é `contas-em-dia.html`. Depois de editar:

```powershell
powershell -ExecutionPolicy Bypass -File build-vercel.ps1
git add .
git commit -m "Ajustes"
git push
```

A Vercel reimplanta sozinha a cada `git push` — não precisa repetir os passos 2-5.

## O que cada cliente ganha

- Conta própria (email + senha, senha guardada com hash — nunca em texto puro)
- Lançamentos, metas e investimentos separados por conta — ninguém vê o de outro
- Sem depender de login na Claude nem do app do Claude

## O que fica de fora deste modo (comparado a abrir dentro do Claude)

- Assistente com IA (entender frases livres, ler foto de nota fiscal) — depende
  da plataforma do Claude, que não existe aqui
- O resto (lançar por texto, metas, investimentos, gráficos) funciona igual
