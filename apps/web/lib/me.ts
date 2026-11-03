/** Who is signed in, from `GET /api/v1/auth/me`. */
export type Me =
    | {
          principal: "account";
          /** `sso`: the account is tied to Kore ID. */
          account: { id: number; email: string; name: string; sso: boolean };
      }
    | { principal: "token"; token: { id: number; name: string } };

/** The `/auth/me` answer, trimmed to who is signed in. */
export function toMe(body: Record<string, unknown>): Me {
    if (body.principal === "account") {
        const account = body.account as Extract<Me, { principal: "account" }>["account"];
        return {
            principal: "account",
            account: {
                id: account.id,
                email: account.email,
                name: account.name,
                sso: account.sso === true,
            },
        };
    }
    const token = body.token as Extract<Me, { principal: "token" }>["token"];
    return { principal: "token", token: { id: token.id, name: token.name } };
}

/** The name the sidebar shows: the person, else the token they signed in with. */
export function displayName(me: Me): string {
    const name = me.principal === "account" ? me.account.name : me.token.name;
    return name.trim() || "Operator";
}
