/** The backend's only password rule (`MIN_PASSWORD_CHARS` in `accounts.rs`). */
export const MIN_PASSWORD_CHARS = 10;

/** What is wrong with a new password and its confirmation, or `null`. */
export function passwordProblem(password: string, confirm: string): string | null {
    if (Array.from(password).length < MIN_PASSWORD_CHARS) {
        return `Use at least ${MIN_PASSWORD_CHARS} characters.`;
    }
    if (password !== confirm) {
        return "The passwords do not match.";
    }
    return null;
}
