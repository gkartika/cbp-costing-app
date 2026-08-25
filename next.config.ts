import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tests build/start their own server (see tests/globalSetup.ts) so they can
  // run concurrently with a developer's live `next dev` without the two
  // processes fighting over the same build output.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // No third-party origins are ever needed by this app; frame-ancestors
          // backstops X-Frame-Options for browsers that only honor CSP.
          // 'unsafe-inline' on script/style is a pragmatic default for
          // Next.js without nonce-based CSP wiring — still blocks loading
          // any script/style/frame from a third-party origin, which is the
          // part that matters for an app with no third-party integrations.
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
