// @ts-check
// One address policy for the runner, the server and the CLI. bin/emuly.mjs holds a pasted copy of
// the block between the markers; lib/emuly-cli-proxy.test.ts fails when the two differ.
// No runtime dependencies, Node 16 or later.
import { isIP } from "node:net";

// ip-policy:start
/**
 * The 8 groups of an IPv6 address, with a dotted IPv4 tail as the last 2, or undefined.
 * @param {string} ip @returns {number[] | undefined}
 */
function ipv6Groups(ip) {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  if (fill < 0) return undefined;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : undefined;
}

/**
 * The family of an address, its IPv6 groups, and the IPv4 address that an IPv6 form carries:
 * ::/96 (with :: and ::1), ::ffff:0:0/96 and NAT64 64:ff9b::/96. Family 0 means not an address.
 * @param {string} ip @returns {{ family: number, groups?: number[], embedded?: string }}
 */
function parseAddress(ip) {
  const family = isIP(ip);
  if (family !== 6) return { family };
  const groups = ipv6Groups(ip);
  if (!groups) return { family: 0 };
  const [g0, g1, g2, g3, g4, g5] = groups;
  const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  if (!g0 && !g1 && !g2 && !g3 && !g4 && (g5 === 0 || g5 === 0xffff)) return { family, groups, embedded };
  if (g0 === 0x64 && g1 === 0xff9b && !g2 && !g3 && !g4 && !g5) return { family, groups, embedded };
  return { family, groups };
}

/**
 * IPv4 ranges that no outside request may reach: this network, private, shared (CGNAT), loopback,
 * link-local, IETF protocol (192.0.0/24), TEST-NET-1 (192.0.2/24), benchmarking (198.18/15),
 * TEST-NET-2 (198.51.100/24), TEST-NET-3 (203.0.113/24), multicast and reserved.
 * @param {string} ip dotted quad @returns {boolean}
 */
function blockedV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/**
 * Global unicast IPv6 only (2000::/3), without 6to4 (2002::/16), 2001::/23 (Teredo and other
 * protocols) and documentation (2001:db8::/32, 3fff::/16).
 * @param {number[]} groups @returns {boolean}
 */
function globalV6(groups) {
  const [g0, g1] = groups;
  if ((g0 & 0xe000) !== 0x2000 || g0 === 0x2002 || g0 === 0x3fff) return false;
  return g0 !== 0x2001 || (g1 >= 0x200 && g1 !== 0xdb8);
}

/**
 * Strict: true only for an ordinary public address. An IPv6 form that carries IPv4 is refused.
 * For downloads, webhooks and region hints.
 * @param {string} ip @returns {boolean}
 */
function publicOnly(ip) {
  const parsed = parseAddress(ip);
  if (parsed.family === 4) return !blockedV4(ip);
  return parsed.family === 6 && !parsed.embedded && globalV6(/** @type {number[]} */ (parsed.groups));
}

/**
 * True when a connection to this address must be refused: every range that `publicOnly` refuses,
 * but an IPv6 form that carries IPv4 is judged by that IPv4 address. For the egress gateway and
 * the CLI proxy.
 * @param {string} ip @returns {boolean}
 */
function lanBlocked(ip) {
  const parsed = parseAddress(ip);
  if (parsed.family === 4) return blockedV4(ip);
  if (parsed.family !== 6) return true;
  if (parsed.embedded) return blockedV4(parsed.embedded);
  return !globalV6(/** @type {number[]} */ (parsed.groups));
}
// ip-policy:end

export { ipv6Groups, parseAddress, publicOnly, lanBlocked };
