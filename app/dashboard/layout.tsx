import { redirect } from "next/navigation";
import { getSessionAccount } from "@/lib/auth";
import { DashboardNav } from "@/components/dashboard-nav";
import { Logo } from "@/components/ui";

export const metadata = { title: "Dashboard — ScoutNet" };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const account = await getSessionAccount();
  if (!account) redirect("/signin");
  const showOutbox = process.env.NODE_ENV !== "production" || process.env.DEV_OUTBOX === "1";

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3.5">
          <Logo />
          <DashboardNav showOutbox={showOutbox} />
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            <span className="hidden max-w-[12rem] truncate sm:inline">{account.email}</span>
            <form action="/api/auth/signout" method="post">
              <button className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 font-semibold text-slate-700 transition-colors hover:bg-slate-100">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
