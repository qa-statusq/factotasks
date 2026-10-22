import type { MetadataRoute } from "next";

/**
 * Serve /robots.txt. This is a PRIVATE, auth-gated admin panel, so disallow all
 * crawlers entirely — nothing here (not even the login page) should be indexed.
 * Also stops the recurring 404s bots generate by probing /robots.txt.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
