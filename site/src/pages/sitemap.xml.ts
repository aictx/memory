import { buildSitemapXml, staticSitePaths } from "../seo";

export function GET(): Response {
  return new Response(buildSitemapXml(staticSitePaths), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8"
    }
  });
}
