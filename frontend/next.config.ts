import type { NextConfig } from "next";

// STATIC_EXPORT=1 builds plain files for Firebase Hosting (out/). The API is then called directly at
// NEXT_PUBLIC_API_BASE_URL with a Bearer token. Without it, /api is forwarded to the Go backend (local development).
const staticExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  // Keep the dev badge away from the top bar buttons.
  devIndicators: { position: "bottom-left" },
  ...(staticExport
    ? { output: "export", images: { unoptimized: true } }
    : {
        async rewrites() {
          if (process.env.NEXT_PUBLIC_API_MODE !== "http") return [];
          const target = process.env.API_PROXY_TARGET || "http://localhost:8080";
          return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
        },
      }),
};

export default nextConfig;
