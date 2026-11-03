/** A member account, as `GET /api/v1/users` lists it. */
export interface Member {
    id: number;
    email: string;
    name: string;
    createdAt: string;
    tokenCount: number;
    /** The account is tied to a Kore ID subject. */
    sso: boolean;
}

/** A token a member made, from `GET /api/v1/users/{id}`. */
export interface MemberToken {
    id: number;
    name: string;
    active: boolean;
}

/**
 * The warning before removing a member, when removing them leaves no
 * account. Access comes from Kore ID, so the next sign-in provisions a new
 * one; the person must still be granted the app there.
 */
export function removalWarning(members: Member[], removingId: number): string | null {
    const others = members.filter((member) => member.id !== removingId);
    return others.length === 0
        ? "This is the last account. The next Kore ID sign-in will provision a new operator; nobody can sign in until then."
        : null;
}
