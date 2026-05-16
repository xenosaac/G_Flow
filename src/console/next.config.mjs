import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Silence the "inferred workspace root" warning by pinning to the repo root.
  outputFileTracingRoot: REPO_ROOT,
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
