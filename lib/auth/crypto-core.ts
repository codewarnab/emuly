import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM. Layout: keyId(1) || iv(12) || tag(16) || ciphertext.
    keyId lets a future key rotation decrypt old rows with the old key. */
const KEY_ID = 1;

function key(id: number, tokenKey: string): Buffer {
  if (id !== KEY_ID) throw new Error(`Unknown token key id ${id}`);
  const k = Buffer.from(tokenKey, "base64");
  if (k.length !== 32) throw new Error("EMULY_TOKEN_KEY must be 32 bytes, base64");
  return k;
}

export function seal(plain: string, tokenKey: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(KEY_ID, tokenKey), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([KEY_ID]), iv, c.getAuthTag(), ct]);
}

export function open(box: Uint8Array, tokenKey: string): string {
  const b = Buffer.from(box);
  if (b.length < 29) throw new Error("Invalid encrypted token");
  const d = createDecipheriv("aes-256-gcm", key(b[0]!, tokenKey), b.subarray(1, 13));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8");
}

export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}
