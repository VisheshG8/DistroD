import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Distribution Desk · Your pages, together",
  description: "A private workspace to collect public social pages and see their combined performance.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
