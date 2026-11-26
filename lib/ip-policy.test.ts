import test from "node:test";
import assert from "node:assert/strict";
import { lanBlocked, publicOnly } from "../phone/runner/ip-policy.mjs";

const blocked = [
  "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
  "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
  "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "3fff::1", "2002:c000:0204::1", "2001::1",
  "64:ff9b::a00:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "not-an-ip",
];
const open = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700::1111", "2a00:1450::1"];

test("every private, reserved and documentation range is refused by both presets", () => {
  for (const address of blocked) {
    assert.equal(publicOnly(address), false, `publicOnly ${address}`);
    assert.equal(lanBlocked(address), true, `lanBlocked ${address}`);
  }
});

test("public addresses pass both presets", () => {
  for (const address of open) {
    assert.equal(publicOnly(address), true, address);
    assert.equal(lanBlocked(address), false, address);
  }
});

test("an IPv6 form that carries a public IPv4 address is judged by that address only for LAN checks", () => {
  for (const address of ["::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    assert.equal(lanBlocked(address), false, address);
    assert.equal(publicOnly(address), false, address);
  }
  assert.equal(lanBlocked("64:ff9b:1::808:808"), true);
});
