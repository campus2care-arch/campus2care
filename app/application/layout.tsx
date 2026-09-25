import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Volunteer Application | Campus2Care",
  description:
    "Apply to Campus2Care and share your weekly volunteer availability.",
};

export default function ApplicationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
