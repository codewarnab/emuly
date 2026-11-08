import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
