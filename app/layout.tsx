import type { Metadata } from "next";
import "./globals.css";
import "../components/workspace.css";

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
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
