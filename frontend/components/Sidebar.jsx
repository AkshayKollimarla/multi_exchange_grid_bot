"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// This is the site's default frontend now. Every Trading + Options
// Strategy page is migrated; the classic dashboard stays reachable at the
// explicit /index.html path (server.js special-cases that one path so
// it's never shadowed by this app's own index.html) only as a fallback,
// not linked from here anymore.
const TRADING_ITEMS = [
  { key: "config", label: "Bot Configuration", icon: "⚙️", href: "/bot-configuration" },
  { key: "accounts", label: "Accounts", icon: "👤", href: "/accounts" },
  { key: "report", label: "PnL Report", icon: "📈", href: "/pnl-report" },
  { key: "logs", label: "Bot Logs", icon: "📜", href: "/bot-logs" },
  { key: "active", label: "Active Bot", icon: "🟢", href: "/active-bot" },
];

const OPTIONS_ITEMS = [
  { key: "optdash", label: "Options Dashboard", icon: "▦", href: "/options-dashboard" },
  { key: "optadd", label: "Add Strategy", icon: "＋", href: "/add-strategy" },
  { key: "optsim", label: "Combined Simulator", icon: "▤", href: "/combined-simulator" },
  { key: "optanalysis", label: "Options Analysis", icon: "／", href: "/options-analysis" },
];

function NavItem({ item, pathname }) {
  const isActive = pathname === item.href;
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
    </aside>
  );
}
