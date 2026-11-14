import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM. Layout: version(1) || iv(12) || tag(16) || ciphertext.
    Version 1: legacy, no AAD. Read only.
    Version 2: the context string (for example `users:gh:42:access`) is the AAD, so a value
    copied into another row or column fails to decrypt. */
const LEGACY = 1;
const BOUND = 2;

function key(tokenKey: string): Buffer {
  const k = Buffer.from(tokenKey, "base64");
  if (k.length !== 32) throw new Error("EMULY_TOKEN_KEY must be 32 bytes, base64");
  return k;
}

export function seal(plain: string, tokenKey: string, context: string): Buffer {
  if (!context) throw new Error("Encryption context is required");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(tokenKey), iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([BOUND]), iv, c.getAuthTag(), ct]);
}

/** One key, or a list with the current key first and retired keys after it.
    GCM authentication fails under a wrong key, so each key is tried in order. */
export type TokenKeys = string | readonly string[];

export function open(box: Uint8Array, tokenKeys: TokenKeys, context: string): string {
  return openWithKey(box, tokenKeys, context).plain;
}

/** keyIndex 0 means the current key. A higher index means the value needs re-encryption. */
export function openWithKey(box: Uint8Array, tokenKeys: TokenKeys, context: string): { plain: string; keyIndex: number } {
  const b = Buffer.from(box);
  if (b.length < 29) throw new Error("Invalid encrypted token");
  const version = b[0]!;
  if (version !== LEGACY && version !== BOUND) throw new Error(`Unknown token version ${version}`);
  if (version === BOUND && !context) throw new Error("Encryption context is required");
  const keys = typeof tokenKeys === "string" ? [tokenKeys] : tokenKeys;
  for (const [keyIndex, tokenKey] of keys.entries()) {
    const d = createDecipheriv("aes-256-gcm", key(tokenKey), b.subarray(1, 13));
    if (version === BOUND) d.setAAD(Buffer.from(context, "utf8"));
    d.setAuthTag(b.subarray(13, 29));
    try {
      return { plain: Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8"), keyIndex };
    } catch { /* wrong key or tampered value: try the next key */ }
  }
  throw new Error("Unable to decrypt token");
}

/** True when the value predates context binding and should be sealed again. */
export function isLegacy(box: Uint8Array): boolean {
  return box[0] === LEGACY;
}

/** Context strings. Keep them stable: changing one makes existing rows unreadable. */
export const contexts = {
  githubAccess: (githubId: number | bigint) => `users:gh:${githubId}:access`,
  githubRefresh: (githubId: number | bigint) => `users:gh:${githubId}:refresh`,
  webhookSecret: (webhookId: string) => `webhooks:${webhookId}:secret`,
};

export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}
