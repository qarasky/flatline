import { AuthScreen } from "@qarasky/kore-ui";
import type { Metadata } from "next";
import Link from "next/link";

import { ChangePasswordForm } from "@/components/change-password-form";
import { currentMe } from "@/lib/auth-server";
import { KORE_APP, KORE_NAMES } from "@/lib/kore";
import { HOME_PATH } from "@/lib/session";

export const metadata: Metadata = { title: "Change password · Flatline" };

/**
 * Outside the admin layout on purpose: an account with a starting password is
 * sent here and must not see anything else until it has chosen its own.
 */
export default async function ChangePasswordPage() {
    const me = await currentMe();
    if (me.principal === "account") {
        return <ChangePasswordForm email={me.account.email} required={me.account.mustChangePassword} />;
    }
    return (
        <AuthScreen
            app={KORE_APP}
            names={KORE_NAMES}
            title="Change password"
            description="You signed in with a token, which has no password to change."
            footer={
                <Link href={HOME_PATH} className="hover:text-text">
                    Back to Flatline
                </Link>
            }
        />
    );
}
