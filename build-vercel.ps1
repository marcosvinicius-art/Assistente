# Gera index.html na raiz do projeto, pronto pra deploy na Vercel junto com /api.
#
# Por que existe: contas-em-dia.html nao tem <!doctype>, <meta charset> nem
# <meta viewport> — quem injeta isso e a plataforma do Claude, ao publicar. Servido
# cru em outro host, o site sai com acentos quebrados e sem escala no celular.
# Este script embrulha o mesmo arquivo num documento HTML completo, entao continua
# existindo uma unica fonte: edite contas-em-dia.html e rode este script de novo.
#
# O icone da aba, o manifest e os metas de "instalar como app" vao aqui no
# <head>, e nao so no contas-em-dia.html: o conteudo dele cai dentro do <body>,
# e o navegador ignora essas declaracoes no corpo — a aba ficava com o globo
# generico e "Adicionar a tela inicial" virava so um atalho do navegador.
#
# index.html fica na RAIZ (nao em public/) porque e ali, ao lado de /api, que a
# Vercel espera os arquivos estaticos quando o projeto tem funcoes serverless.
#
# Uso:  powershell -ExecutionPolicy Bypass -File build-vercel.ps1

$ErrorActionPreference = "Stop"

$raiz = $PSScriptRoot
$fonte = Get-Content (Join-Path $raiz "contas-em-dia.html") -Raw -Encoding UTF8

$cabecalho = @'
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wonner Sols</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#001539">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Wonner Sols">
</head>
<body>
'@

$rodape = @'
</body>
</html>
'@

# Sem BOM: alguns servidores estaticos entregam o BOM como conteudo visivel.
$utf8SemBom = New-Object System.Text.UTF8Encoding($false)
$saida = $cabecalho + "`n" + $fonte + "`n" + $rodape
[System.IO.File]::WriteAllText((Join-Path $raiz "index.html"), $saida, $utf8SemBom)

Write-Output "index.html gerado a partir de contas-em-dia.html ($((Get-Item (Join-Path $raiz 'index.html')).Length) bytes)."
