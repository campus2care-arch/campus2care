import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.campus2care.org"),
  title: "Campus2Care | Hospital Volunteer Pathways for Students",
  description:
    "Campus2Care helps students prepare for and navigate hospital volunteer pathways through mentorship, workshops, and cohort support.",
  applicationName: "Campus2Care",
  icons: {
    icon: "/images/C2C-logo.png",
    apple: "/images/C2C-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
