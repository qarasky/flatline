import { NextResponse, type NextRequest } from "next/server";

import { gate } from "@/lib/gate";
import { PATH_HEADER, SESSION_COOKIE } from "@/lib/session";

/**
 * Optimistic sign-in gate (Next 16 "proxy", formerly middleware). It only
 * checks that the session cookie exists; server layouts verify it through
 * `requireOperator`.
 */
export function proxy(req: NextRequest) {
    const { pathname, search } = req.nextUrl;
    const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
    const result = gate(pathname, search, hasSession);
    if (result.kind === "redirect") {
        return NextResponse.redirect(new URL(result.to, req.url));
    }
    const headers = new Headers(req.headers);
    headers.set(PATH_HEADER, pathname + search);
    return NextResponse.next({ request: { headers } });
}

export const config = {
    matcher: ["/((?!api/|agent/|_next/|icon.svg|favicon.ico|robots.txt).*)"],
};
