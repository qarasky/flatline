"use client";

import { useEffect, useState } from "react";
import { AuthScreen } from "@qarasky/kore-ui";

import { api } from "@/lib/api";
import { KORE_APP, KORE_NAMES } from "@/lib/kore";
import { NO_SIGN_IN, type SignInMethods, ssoStartHref, toMethods } from "@/lib/sso";

/**
 * The wall screen signs in the same way as every other browser: through
 * Kore ID. Without it, the screen says no sign-in method is configured.
 */
export function KioskSignIn() {
    const [methods, setMethods] = useState<SignInMethods | null>(null);
    const [unreachable, setUnreachable] = useState(false);
    const [next, setNext] = useState<string | null>(null);

    useEffect(() => {
        setNext(window.location.pathname + window.location.search);
        api<Record<string, unknown>>("/api/v1/auth/sso/config")
            .then((answer) => setMethods(toMethods(answer)))
            .catch(() => {
                setMethods(NO_SIGN_IN);
                setUnreachable(true);
            });
    }, []);

    if (methods === null) {
        return <AuthScreen app={KORE_APP} names={KORE_NAMES} title="Sign in" description="Signing in…" />;
    }

    return (
        <AuthScreen
            app={KORE_APP}
            names={KORE_NAMES}
            title="Sign in"
            description={methods.sso ? "Sign in to monitor your sites and servers." : undefined}
            sso={methods.sso ? { href: ssoStartHref(next) } : undefined}
            error={
                unreachable
                    ? "Could not reach Flatline. Try again."
                    : methods.sso
                      ? null
                      : "No sign-in method is configured on this instance. Ask an administrator to set KORE_ID_ISSUER."
            }
        />
    );
}
