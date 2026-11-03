import { isApiError } from "@/lib/api";

/** What a dialog says when a write failed: the API's own explanation, else "try again". */
export function failureMessage(error: unknown): string {
    // An unreachable or busy server is "try again"; anything else the API
    // explains itself.
    if (isApiError(error) && error.status !== 503 && error.message) {
        return error.message;
    }
    return "Could not reach KoreMonitor. Try again.";
}
