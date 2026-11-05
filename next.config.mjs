/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@prisma/client", "prisma", "unpdf", "mammoth", "ws"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
