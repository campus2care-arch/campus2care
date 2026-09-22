import type { Metadata } from "next";

// This page is unlisted. It is reached only through the link we email out, so
// it is kept out of search engines and is not linked from anywhere on the site.
export const metadata: Metadata = {
  title: "Volunteer Availability | Campus2Care",
  robots: { index: false, follow: false, nocache: true },
};

export default function AvailabilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
