import Link from "next/link";
import { Logo } from "@/components/ui";
import { SignInForm } from "./signin-form";

export const metadata = { title: "Sign in — ScoutNet" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-slate-50 px-6 py-16">
      <div className="w-full max-w-md">
        <Link href="/" className="inline-block">
          <Logo />
        </Link>
        <div className="card-soft mt-6 p-8">
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            Sign in or create your account
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Sign in to ScoutNet — no password, just a magic link. New here? This is also how
            you sign up.
          </p>
          {error === "expired" && (
            <p className="mt-4 rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-600" role="alert">
              That link expired or was already used. Request a fresh one below.
            </p>
          )}
          {error === "invalid" && (
            <p className="mt-4 rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-600" role="alert">
              That link wasn&rsquo;t valid. Request a fresh one below.
            </p>
          )}
          <SignInForm />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">
          By continuing you agree to use ScoutNet for your own business&rsquo;s outreach.
        </p>
      </div>
    </main>
  );
}
