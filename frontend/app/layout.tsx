import type { Metadata, Viewport } from "next";
import { Poppins, Unbounded } from "next/font/google";
import { Providers } from "@/components/shell/Providers";
import "./globals.css";

const unbounded = Unbounded({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-unbounded", display: "swap" });
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-poppins", display: "swap" });

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Research Map";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "A visual research workspace that turns your browser research into an organized, explainable knowledge graph.",
};

export const viewport: Viewport = { themeColor: "#f5f1e8" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${unbounded.variable} ${poppins.variable}`}>
      <body className="min-h-dvh bg-app antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
