import "server-only";
import { env } from "../env.ts";
import * as crypto from "./crypto-core.ts";

export const seal = (plain: string, context: string) => crypto.seal(plain, env.tokenKey, context);
export const open = (box: Uint8Array, context: string) => crypto.open(box, env.tokenKeys, context);
export const { randomId, sha256, contexts, isLegacy } = crypto;
