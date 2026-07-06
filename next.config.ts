import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "tfddjmplcizfirxqhotv.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

// Sentry wrapper. Runtime error capture is gated on NEXT_PUBLIC_SENTRY_DSN
// (set in each Sentry.init); source-map upload only runs when SENTRY_AUTH_TOKEN
// is present (prod build), so local/CI builds without it just build normally.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  // Route client events through our own origin so ad-blockers don't drop them.
  // The proxy short-circuits /monitoring (mirroring the /api/health bypass).
  tunnelRoute: "/monitoring",
});
