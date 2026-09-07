import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vexy-mailer",
  description: "Internal cold email outreach",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
