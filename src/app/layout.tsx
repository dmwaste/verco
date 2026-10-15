import type { Metadata } from "next";
import { QueryProvider } from "@/lib/query-provider";
import { poppins, poppinsExt, dmSans, dmSansExt } from "./_fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Verco — Verge Collection Bookings",
  description: "Book your residential bulk verge collection online.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${poppinsExt.variable} ${dmSans.variable} ${dmSansExt.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
