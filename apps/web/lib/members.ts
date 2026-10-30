/** A member account, as `GET /api/v1/users` lists it. */
export interface Member {
    id: number;
    email: string;
    name: string;
    mustChangePassword: boolean;
    startingPasswordExpired: boolean;
    createdAt: string;
    tokenCount: number;
}

/** A token a member made, from `GET /api/v1/users/{id}`. */
export interface MemberToken {
    id: number;
    name: string;
    active: boolean;
}

export type MemberStatus = "active" | "awaiting-first-sign-in" | "needs-reset";

/** Where a member stands with their password. */
export function memberStatus(member: Member): MemberStatus {
    if (!member.mustChangePassword) {
        return "active";
    }
    return member.startingPasswordExpired ? "needs-reset" : "awaiting-first-sign-in";
}

/** The warning before removing a member, when removing them leaves no account. */
export function removalWarning(members: Member[], removingId: number): string | null {
    const others = members.filter((member) => member.id !== removingId);
    return others.length === 0
        ? "This is the last account. Signing in will need a token until someone adds an account."
        : null;
}
