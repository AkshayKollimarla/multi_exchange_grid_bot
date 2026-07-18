/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: built locally, the `out/` folder is copied onto EC2 and
  // served by the existing server.js (same origin as the API, so the
  // session-cookie auth already in place keeps working unchanged).
  output: "export",
  // This is now the default site — served at the root. The classic
  // dashboard stays reachable at the explicit /index.html path (server.js
  // special-cases that one path) for the pages not yet migrated.
  // The parent repo (multi_exchange_grid_bot) has its own package-lock.json
  // one level up, which made Turbopack guess the wrong workspace root.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
