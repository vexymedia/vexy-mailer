import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "vexy-mailer",
  description: "Interní nástroj pro cold outreach a volání",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
