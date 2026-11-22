import type { MetadataRoute } from "next";
import { env } from "../lib/env";

export default function sitemap(): MetadataRoute.Sitemap {
  const b = env.baseUrl;
  return [
    { url: b, changeFrequency: "weekly", priority: 1 },
    { url: `${b}/compare`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${b}/self-host`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${b}/agent.md`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${b}/llms.txt`, changeFrequency: "weekly", priority: 0.5 },
  ];
}
