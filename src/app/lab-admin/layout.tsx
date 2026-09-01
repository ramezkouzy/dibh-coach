import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trace administration | DIBH Lab",
  robots: {
    index: false,
    follow: false,
  },
};

export default function LabAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
