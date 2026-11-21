import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { env } from "../lib/env";
import { SELF_HOST } from "../lib/selfhost";

/** Search and AI crawlers may read the public pages. A self-hosted copy asks not to be indexed. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  if (SELF_HOST) {
    await connection();
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app/", "/api/", "/auth/", "/v1/", "/link", "/open/"] },
    sitemap: `${env.baseUrl}/sitemap.xml`,
    host: env.baseUrl,
  };
}
