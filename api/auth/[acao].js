// As rotas de conta num arquivo só, pelo mesmo motivo das de admin: o plano
// gratuito da Vercel aceita 12 funções por projeto, e cada arquivo de api/ conta
// como uma. Os arquivos com "_" na frente não contam — são só código importado.
//
// A rota dinâmica mantém os endereços de sempre (/api/auth/login continua
// /api/auth/login), então o app não precisou mudar nada.
var ACOES = {
  login: require("./_login"),
  logout: require("./_logout"),
  me: require("./_me"),
  senha: require("./_senha"),
  signup: require("./_signup"),
};

module.exports = function handler(req, res) {
  var acao = ACOES[req.query.acao];
  if (!acao) return res.status(404).json({ error: "not_found" });
  return acao(req, res);
};
