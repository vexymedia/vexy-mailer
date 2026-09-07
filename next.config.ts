import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres", "imapflow", "nodemailer"],
};

export default nextConfig;
