import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OAuth callback URLs contain one-time codes. Never write request URLs to dev logs.
  logging: { incomingRequests: false },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
