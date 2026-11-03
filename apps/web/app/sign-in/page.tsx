import type { Metadata } from "next";

import { SignInForm } from "@/components/sign-in-form";

export const metadata: Metadata = { title: "Sign in · Flatline" };

export default async function SignInPage({
    searchParams,
}: {
    searchParams: Promise<{
        next?: string | string[];
        expired?: string | string[];
        sso_error?: string | string[];
    }>;
}) {
    const params = await searchParams;
    const next = typeof params.next === "string" ? params.next : null;
    const ssoError = typeof params.sso_error === "string" ? params.sso_error : null;
    return (
        <main className="flex min-h-svh items-center justify-center p-6">
            <SignInForm next={next} expired={params.expired !== undefined} ssoError={ssoError} />
        </main>
    );
}
