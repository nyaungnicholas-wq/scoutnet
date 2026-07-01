import Link from "next/link";
import { ButtonLink, Logo } from "@/components/ui";

const STEPS = [
  {
    n: "1",
    title: "Pick a trade and a place",
    body: "Choose a recession-resistant trade — HVAC, dental, roofing, law — and a city. ScoutNet searches the web for the real businesses operating there.",
  },
  {
    n: "2",
    title: "It scores who's worth it",
    body: "Each business gets read and scored: steady income signals (reviews, age, ratings) against digital gaps (no site, no SSL, dead marketing). Every point shows its evidence.",
  },
  {
    n: "3",
    title: "Auto-send the best, review the rest",
    body: "The strongest matches get an honest, evidence-based pitch sent from your own domain. Everything below your threshold waits in a review queue for your call.",
  },
];

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const FEATURES = [
  {
    t: "Searches the real web",
    b: "Google Places when you have a key, free OpenStreetMap when you don't, and sample data to test the whole loop offline. Same scoring, whatever the source.",
    p: "M21 21l-4.3-4.3M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z",
  },
  {
    t: "Scores stable income vs. weak presence",
    b: "The whole point: a 14-year, 200-review shop with a broken 2016 website outranks a flashy startup with no track record. Money you can see, gaps you can fix.",
    p: "M4 19V5m0 14h16M8 16V9m4 7V6m4 10v-4",
  },
  {
    t: "Drafts an honest pitch",
    b: "Every email references what ScoutNet actually found — no SSL, dead reviews, no booking — never invented flattery. You edit any word before it goes.",
    p: "M3 8l9 6 9-6M4 6h16v12H4z",
  },
  {
    t: "Hybrid send, your threshold",
    b: "Set the bar. Leads at or above it auto-send; the rest queue for your review. You're never blasting, and you're never hand-sending the obvious wins.",
    p: "M12 14l3.5-3.5M5.5 19a9 9 0 1 1 13 0",
  },
  {
    t: "Sends from your domain",
    b: "Your own Resend key, your own verified domain, your reputation. Cold outreach never rides a shared platform domain — by design, not by setting.",
    p: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1",
  },
  {
    t: "CAN-SPAM built in",
    b: "Your postal address and a one-click unsubscribe on every email, non-removable. One cold approach per business, ever — no re-pitch barrage, no re-contacting an opt-out.",
    p: "M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6zM9.5 11.5l2 2 3.5-3.5",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen w-full bg-slate-50">
      {/* Floating nav */}
      <div className="sticky top-0 z-30 px-4 pt-4">
        <header className="mx-auto flex max-w-6xl items-center justify-between rounded-2xl border border-slate-200 bg-white/85 px-5 py-3 shadow-soft backdrop-blur">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 sm:flex">
            <a href="#how" className="transition-colors hover:text-sky-900">How it works</a>
            <a href="#features" className="transition-colors hover:text-sky-900">Features</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/signin" className="hidden text-sm font-semibold text-slate-700 hover:text-sky-900 sm:block">
              Sign in
            </Link>
            <ButtonLink href="/signin" size="sm">Get started</ButtonLink>
          </div>
        </header>
      </div>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-[-10rem] h-[28rem] w-[44rem] -translate-x-1/2 rounded-full bg-sky-100/60 blur-3xl" />
        </div>
        <div className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center sm:pt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-semibold text-sky-800">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
            For web designers, marketers &amp; agencies
          </span>
          <h1 className="mt-5 font-display text-4xl font-bold leading-[1.08] tracking-tight text-slate-900 sm:text-6xl">
            Find the businesses that need you.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            ScoutNet searches the web for stable, money-making local businesses whose website or
            marketing is quietly costing them customers — scores each on the evidence, drafts an
            honest pitch, and sends it from your own domain. Auto for the strongest, your review
            for the rest.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <ButtonLink href="/signin" size="lg">Find leads free</ButtonLink>
            <ButtonLink href="#how" variant="secondary" size="lg">See how it works</ButtonLink>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            No credit card. Runs free on OpenStreetMap + sample data; add a Google Places key for richer data.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-wider text-sky-700">How it works</p>
          <h2 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-900">From cold web to warm lead in three steps</h2>
        </div>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="card-soft p-6">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-sky-900 font-display font-bold text-white">{s.n}</span>
              <h3 className="mt-4 font-display text-lg font-bold text-slate-900">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-y border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-wider text-sky-700">What you get</p>
            <h2 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-900">
              A prospecting agent that does the boring part — finding and qualifying.
            </h2>
          </div>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.t} className="rounded-2xl border border-slate-200 p-5 transition-colors hover:border-sky-300">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-sky-50 text-sky-700">
                  <Icon path={f.p} />
                </span>
                <h3 className="mt-4 font-display text-base font-bold text-slate-900">{f.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{f.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Honest by design */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="card-soft grid items-center gap-8 p-8 sm:grid-cols-2 sm:p-12">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-sky-700">Honest by design</p>
            <h2 className="mt-2 font-display text-3xl font-bold tracking-tight text-slate-900">
              A pitch you&rsquo;d be happy to receive.
            </h2>
            <p className="mt-4 leading-relaxed text-slate-600">
              Every claim in a ScoutNet email traces to something it actually observed on the
              business&rsquo;s own site — no invented flattery, no fake &ldquo;RE:&rdquo; lines. Your
              real address and a one-click unsubscribe ride along on every send, and an opt-out is
              honored forever.
            </p>
            <div className="mt-6">
              <ButtonLink href="/signin">Find your first lead</ButtonLink>
            </div>
          </div>
          <div className="rounded-2xl bg-slate-900 p-6 text-sm">
            <div className="flex items-center gap-2 text-slate-400">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-accent-500" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </div>
            <div className="mt-4 space-y-3 font-mono text-xs leading-relaxed text-slate-300">
              <p><span className="text-sky-300">scan</span> — HVAC · Tucson, AZ · 10 businesses</p>
              <p><span className="text-emerald-400">score 88</span> — Hartwell Heating · 14y · 180 reviews</p>
              <p><span className="text-accent-500">gap</span> — no SSL, © 2016, no booking</p>
              <p><span className="text-slate-500">auto-sent → honest pitch from your domain ✓</span></p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-3xl px-6 pb-20 text-center">
        <h2 className="font-display text-3xl font-bold tracking-tight text-slate-900">
          Your next client is already in business.
        </h2>
        <p className="mx-auto mt-3 max-w-lg text-slate-600">
          They&rsquo;ve got steady revenue and a website that&rsquo;s letting them down. ScoutNet finds
          them, proves the gap, and starts the conversation — honestly.
        </p>
        <div className="mt-7">
          <ButtonLink href="/signin" size="lg">Get started free</ButtonLink>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 sm:flex-row">
          <Logo />
          <p className="text-sm text-slate-500">Find the businesses that need you.</p>
        </div>
      </footer>
    </main>
  );
}
