"use client";

import { useEffect, useState } from "react";

import { AuthScreen } from "@qarasky/kore-ui";

import { api } from "@/lib/api";
import { KORE_NAMES } from "@/lib/kore";
import { NO_SIGN_IN, type SignInMethods, ssoErrorMessage, ssoStartHref, toMethods } from "@/lib/sso";

/**
 * Kore ID is the only way in. With it configured the screen offers
 * "Continue with Kore ID"; without it, it says no sign-in method is set up.
 */
export function SignInForm({
    next,
    expired,
    ssoError,
}: {
    next: string | null;
    expired: boolean;
    ssoError: string | null;
}) {
    // Which methods this instance allows; null until the backend has said.
    const [methods, setMethods] = useState<SignInMethods | null>(null);
    const [unreachable, setUnreachable] = useState(false);

    useEffect(() => {
        api<Record<string, unknown>>("/api/v1/auth/sso/config")
            .then((answer) => setMethods(toMethods(answer)))
            .catch(() => {
                setMethods(NO_SIGN_IN);
                setUnreachable(true);
            });
    }, []);

    const shared = { app: "flatline" as const, names: KORE_NAMES };

    if (methods === null) {
        return <AuthScreen {...shared} description="Signing in…" />;
    }

    const notice = expired ? "Your session ended. Sign in again." : undefined;
    const sso = methods.sso ? { href: ssoStartHref(next) } : undefined;
    const error = unreachable
        ? "Could not reach Flatline. Try again."
        : !methods.sso
          ? "No sign-in method is configured on this instance. Ask an administrator to set KORE_ID_ISSUER."
          : ssoErrorMessage(ssoError);

    return (
        <AuthScreen
            {...shared}
            description={methods.sso ? "Sign in to monitor your sites and servers." : undefined}
            sso={sso}
            error={error}
            notice={notice}
        />
    );
}
