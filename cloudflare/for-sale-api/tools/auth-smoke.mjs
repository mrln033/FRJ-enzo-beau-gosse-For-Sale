const [baseUrl] = process.argv.slice(2);
const token = String(process.env.FRJ_ADMIN_TOKEN || "").trim();

if (!baseUrl || !token) {
  throw new Error("Usage: FRJ_ADMIN_TOKEN=<secret> node tools/auth-smoke.mjs <base-url>");
}

// Un type volontairement inconnu vérifie l'authentification sans écrire dans D1.
const response = await fetch(`${baseUrl}/?type=auth-check`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: ""
});
const body = await response.json();

console.log(JSON.stringify({ status: response.status, body }, null, 2));

if (response.status !== 400 || !String(body.error || "").includes("Type inconnu")) {
  process.exitCode = 1;
}
