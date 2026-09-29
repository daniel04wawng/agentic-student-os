import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Self-contained server bundle so the Railway runtime image doesn't depend on
  // node_modules surviving dependency pruning in a monorepo build.
  output: "standalone",
  // Pin the trace root to this folder so the standalone output lands flat at
  // .next/standalone/server.js (the repo-root lockfile would otherwise nest it).
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
