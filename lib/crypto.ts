import "server-only";
import { env } from "./env.ts";
import * as crypto from "./crypto-core.ts";

export const seal = (plain: string) => crypto.seal(plain, env.tokenKey);
export const open = (box: Uint8Array) => crypto.open(box, env.tokenKey);
export const { randomId, sha256 } = crypto;
