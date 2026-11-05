/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export: no server. The output folder is published to Swarm and
  // resolved through an ENS name's contenthash.
  output: "export",
  // Every route becomes <route>/index.html, which a Swarm manifest serves as a
  // directory index.
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  // Intentionally no basePath / assetPrefix: both bake an absolute prefix into the
  // build, so the same output could not be served under /bzz/<hash>/, on a bzz
  // subdomain and at an ENS gateway root at once. scripts/postexport.mjs rewrites
  // the emitted HTML and webpack runtime to hash-agnostic relative URLs instead.
  // Workspace packages ship TypeScript sources with `.js` import specifiers.
  transpilePackages: ["@verada/sdk"],
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
