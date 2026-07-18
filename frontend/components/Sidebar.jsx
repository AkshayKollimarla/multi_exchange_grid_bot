"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Items not yet migrated to Next.js stay visible (full visual parity with
// the classic dashboard's sidebar) but are inert during the incremental,
// page-by-page migration — the classic dashboard remains reachable via the
// "Classic Dashboard" link below and still has all of these working.
const TRADING_ITEMS = [
  { key: "accounts", label: "Accounts", icon: "👤", href: null },
  { key: "report", label: "PnL Report", icon: "📈", href: null },
  { key: "logs", label: "Bot Logs", icon: "📜", href: null },
  // Bot Configuration is folded into Active Bot — one simple screen to
  // configure, launch, monitor, and stop bots, instead of two separate pages.
  { key: "active", label: "Active Bot", icon: "🟢", href: "/active-bot" },
];

const OPTIONS_ITEMS = [
  { key: "optdash", label: "Options Dashboard", icon: "▦", href: "/options-dashboard" },
  { key: "optadd", label: "Add Strategy", icon: "＋", href: null },
  { key: "optsim", label: "Combined Simulator", icon: "▤", href: null },
  { key: "optanalysis", label: "Options Analysis", icon: "／", href: null },
];

function NavItem({ item, pathname }) {
  const isActive = item.href && pathname === item.href;
  if (!item.href) {
    return (
      <div className="nav-item disabled" title="Not migrated yet — use the Classic Dashboard">
        <span className="ic">{item.icon}</span> {item.label}
      </div>
    );
  }
  return (
    <Link href={item.href} className={`nav-item${isActive ? " active" : ""}`}>
      <span className="ic">{item.icon}</span> {item.label}
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <div className="brand"><span className="logo">▲</span> GridBot-MultiExchange</div>
      <div className="nav-group">Trading</div>
      {TRADING_ITEMS.map((item) => <NavItem key={item.key} item={item} pathname={pathname} />)}
      <div className="nav-group">Options Strategy</div>
      {OPTIONS_ITEMS.map((item) => <NavItem key={item.key} item={item} pathname={pathname} />)}
      <a
        href="/index.html"
        style={{ marginTop: "auto", fontSize: "11px", color: "#5d6b85", padding: "14px 12px 4px", textDecoration: "underline" }}
      >
        ← Classic Dashboard
      </a>
    </aside>
  );
}
