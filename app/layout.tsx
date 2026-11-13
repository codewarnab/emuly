import type { Metadata, Viewport } from "next";
import { Public_Sans, Sora } from "next/font/google";
import "./globals.css";
import { UIProvider } from "@/components/ui/ui-provider";

const body = Public_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const display = Sora({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const themeScript = `(function(){try{var q=matchMedia("(prefers-color-scheme: dark)");function apply(){var p=localStorage.getItem("emuly-theme");document.documentElement.dataset.theme=p==="light"||p==="dark"?p:q.matches?"dark":"light"}apply();q.addEventListener("change",apply);addEventListener("storage",apply)}catch(e){}})()`;

export const metadata: Metadata = {
  metadataBase: new URL("https://emuly.vercel.app"),
  title: "Emuly — a free Android emulator in the cloud",
  description:
    "Run an Android emulator in the cloud, for free. Use your included GitHub Codespaces hours with one prompt.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body><a className="skip-link" href="#main-content">Skip to content</a><UIProvider>{children}</UIProvider></body>
    </html>
  );
}
