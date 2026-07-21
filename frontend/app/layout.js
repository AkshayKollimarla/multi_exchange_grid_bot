import { Inter, JetBrains_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import "./globals.css";

// Single Inter family for both display and body text, self-hosted via
// next/font. Kept as two next/font instances (same underlying font) so
// globals.css's existing --font-display / --font-body variable split
// doesn't need touching anywhere else in the app.
const fontDisplay = Inter({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display-raw",
});
const fontBody = Inter({
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
