import Link from "next/link";

/* Shared presentational primitives for the ScoutNet design system.
   Server-component friendly (no client state). */

export function Logo({ className = "", mark = true }: { className?: string; mark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {mark && (
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-sky-900 text-white">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
            <path
              d="M3.5 11.2 20.5 4l-4.2 16.3-5.1-5.4-4.4 2.4 1.3-4.6L20.5 4"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      <span className="font-display text-lg font-bold tracking-tight text-sky-900">ScoutNet</span>
    </span>
  );
}

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 cursor-pointer";
const BTN_SIZE: Record<string, string> = {
  md: "px-4 py-2.5",
  sm: "px-3 py-1.5",
  lg: "px-6 py-3 text-base",
};
const BTN_VARIANT: Record<string, string> = {
  primary: "bg-sky-900 text-white hover:bg-sky-800 shadow-soft",
  secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
  ghost: "text-sky-900 hover:bg-sky-50",
  danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
};

export function buttonClass(variant: keyof typeof BTN_VARIANT = "primary", size: keyof typeof BTN_SIZE = "md") {
  return `${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANT[variant]}`;
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
  target,
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof BTN_VARIANT;
  size?: keyof typeof BTN_SIZE;
  className?: string;
  target?: string;
}) {
  const external = href.startsWith("http") || target;
  const cls = `${buttonClass(variant, size)} ${className}`;
  return external ? (
    <a href={href} target={target} rel={target ? "noreferrer" : undefined} className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card-soft p-6 ${className}`}>{children}</div>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">{children}</h2>;
}

const TONE: Record<string, { tile: string; icon: string; value: string }> = {
  sky: { tile: "bg-sky-50", icon: "text-sky-700", value: "text-sky-900" },
  amber: { tile: "bg-accent-50", icon: "text-accent-600", value: "text-slate-900" },
  slate: { tile: "bg-slate-100", icon: "text-slate-500", value: "text-slate-900" },
  red: { tile: "bg-red-50", icon: "text-red-600", value: "text-red-700" },
  emerald: { tile: "bg-emerald-50", icon: "text-emerald-700", value: "text-emerald-900" },
};

export function Stat({
  label,
  value,
  hint,
  tone = "slate",
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: keyof typeof TONE;
  icon?: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className="card-soft p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        {icon && <span className={`grid h-8 w-8 place-items-center rounded-lg ${t.tile} ${t.icon}`}>{icon}</span>}
      </div>
      <p className={`mt-2 font-display text-3xl font-bold tracking-tight ${t.value}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const PILL: Record<string, string> = {
  sky: "bg-sky-100 text-sky-900",
  amber: "bg-accent-100 text-accent-600",
  emerald: "bg-emerald-100 text-emerald-900",
  slate: "bg-slate-200 text-slate-600",
  red: "bg-red-100 text-red-700",
  violet: "bg-violet-100 text-violet-900",
};

export function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: keyof typeof PILL }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${PILL[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <p className="font-display text-lg font-semibold text-slate-800">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
