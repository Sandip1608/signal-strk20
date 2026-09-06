/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Next 16 writes an AGENTS.md + a CLAUDE.md pointing at it. The repo already
  // has a hand-written CLAUDE.md at the root; a generated stub inside app/
  // would shadow it for anyone opening the frontend directory.
  agentRules: false,
}

module.exports = nextConfig
