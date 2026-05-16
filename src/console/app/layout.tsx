import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "G_Flow Console",
  description: "Live state for an open-source coding-agent orchestration flow.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
