import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_BASE_URL ?? "https://scoutnet.example";
  return [
    { url: `${base}/`, priority: 1 },
    { url: `${base}/signin`, priority: 0.5 },
  ];
}
