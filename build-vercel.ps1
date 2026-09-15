# Gera index.html na raiz do projeto, pronto pra deploy na Vercel junto com /api.
#
# Por que existe: contas-em-dia.html nao tem <!doctype>, <meta charset> nem
# <meta viewport> — quem injeta isso e a plataforma do Claude, ao publicar. Servido
# cru em outro host, o site sai com acentos quebrados e sem escala no celular.
# Este script embrulha o mesmo arquivo num documento HTML completo, entao continua
# existindo uma unica fonte: edite contas-em-dia.html e rode este script de novo.
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
