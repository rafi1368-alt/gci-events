const crypto = require("crypto");

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// HTTP Basic Auth gated by ADMIN_PASSWORD. If it isn't set (local dev),
// the admin panel stays open.
function basicAuth(req, res, next) {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) return next();
  const expectedUser = process.env.ADMIN_USER || "admin";

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPassword)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="GCI Events Admin"');
  res.status(401).send("Authentication required.");
}

module.exports = { basicAuth };
