import { clerkKeyWarning } from "./clerk.js";

type LaunchEnv = {
  NODE_ENV: string;
  CORS_ORIGIN: string;
  CLERK_SECRET_KEY?: string | undefined;
  PAYSTACK_SECRET_KEY?: string | undefined;
  ALLOW_PUBLIC_FRONTEND_TOKEN?: string | undefined;
};

/** Settings that are fine in development but wrong for a live service. Names only, never values. */
export function launchWarnings(env: LaunchEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (env.CORS_ORIGIN === "*") out.push("CORS_ORIGIN is *. Set it to the console's address so other sites cannot call this API from a browser.");
  if (env.PAYSTACK_SECRET_KEY?.startsWith("sk_test_")) out.push("PAYSTACK_SECRET_KEY is a test key (sk_test_). No real money moves.");
  if (env.ALLOW_PUBLIC_FRONTEND_TOKEN === "true") out.push("ALLOW_PUBLIC_FRONTEND_TOKEN is on. Anyone can get a console token. Turn it off.");
  const clerk = clerkKeyWarning(env.CLERK_SECRET_KEY, true);
  if (clerk) out.push(clerk);
  return out;
}
