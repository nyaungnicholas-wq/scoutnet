"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Home", exact: true },
  { href: "/dashboard/discover", label: "Discover" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function DashboardNav({ showOutbox }: { showOutbox: boolean }) {
  const pathname = usePathname();
  const links = showOutbox ? [...LINKS, { href: "/dashboard/outbox", label: "Outbox" }] : LINKS;

  return (
    <nav className="flex items-center gap-1 text-sm font-medium">
      {links.map((l) => {
        const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 transition-colors ${
              active ? "bg-sky-50 text-sky-900" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
