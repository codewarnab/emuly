import type { NextConfig } from "next";

/** Applied to every response. Script sources are not restricted yet: that needs a per-request
    nonce, which forces dynamic rendering. frame-ancestors blocks clickjacking now. */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Browsers ignore HSTS on plain HTTP, so localhost and LAN testing are not affected.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // OAuth callback URLs contain one-time codes. Never write request URLs to dev logs.
  logging: { incomingRequests: false },
  cacheComponents: true,
  partialPrefetching: true,
  // Codespace tunnel stack (lib/github/codespace-tunnel.ts). These packages use optional
  // requires (node-rsa, cpu-features) and native Node APIs, so load them with plain require.
  serverExternalPackages: [
    "@microsoft/dev-tunnels-connections", "@microsoft/dev-tunnels-management",
    "@microsoft/dev-tunnels-contracts", "@microsoft/dev-tunnels-ssh", "@microsoft/dev-tunnels-ssh-tcp",
    "@grpc/grpc-js", "ssh2",
  ],
};

export default nextConfig;
