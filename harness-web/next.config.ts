import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The compile route reads .sol sources from node_modules at request time, which
  // Next's static tracing cannot see. Without this the deployed function 404s on
  // every import and every compile fails.
  outputFileTracingIncludes: {
    '/api/compile': [
      './node_modules/solc/**',
      './node_modules/@openzeppelin/contracts/**/*.sol',
      './node_modules/@aave/core-v3/contracts/**/*.sol',
      './node_modules/@aave/periphery-v3/contracts/**/*.sol',
    ],
  },
  /* config options here */
};

export default nextConfig;
