import { Plus_Jakarta_Sans, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import "./globals.css";

// Same three fonts/weights as the classic dashboard's Google Fonts <link>
// (index.html), just self-hosted via next/font instead of an external
// request — visually identical, faster load.
const fontDisplay = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display-raw",
});
const fontBody = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body-raw",
});
const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono-raw",
});

export const metadata = {
  title: "GridBot — Multi-Exchange",
  description: "Multi-exchange grid trading bot dashboard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`}>
      <body>
        <div className="app-shell">
          <Sidebar />
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
