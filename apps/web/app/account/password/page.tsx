import type { Metadata } from "next";
import Link from "next/link";

import { ChangePasswordForm } from "@/components/change-password-form";
import { currentMe } from "@/lib/auth-server";
import { HOME_PATH } from "@/lib/session";

export const metadata: Metadata = { title: "Change password · Flatline" };

/**
 * Outside the admin layout on purpose: an account with a starting password is
 * sent here and must not see anything else until it has chosen its own.
 */
export default async function ChangePasswordPage() {
    const me = await currentMe();
    return (
        <main className="flex min-h-svh items-center justify-center p-6">
            {me.principal === "account" ? (
                <ChangePasswordForm email={me.account.email} required={me.account.mustChangePassword} />
            ) : (
                <div className="flex w-full max-w-sm flex-col gap-4">
                    <p>You signed in with a token, which has no password to change.</p>
                    <Link href={HOME_PATH} className="text-muted-foreground hover:text-foreground">
                        Back to Flatline
                    </Link>
                </div>
            )}
        </main>
    );
}
