const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  auth.clearSessionCookie(res);
  return res.status(200).json({ ok: true });
};
