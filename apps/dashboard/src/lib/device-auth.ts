import qrcode from "qrcode-generator";

/** Quiet zone around the symbol, in modules. The QR specification asks for four. */
const QUIET_ZONE = 4;

function trimSlashes(url: string): string {
    return url.replace(/\/+$/, "");
}

/**
 * The URL a phone opens to approve a waiting screen.
 *
 * The code rides in the fragment so it never reaches server logs or Referer
 * headers, and it survives the phone's own sign-in step.
 * @param base The instance's configured public URL, when it has one
 * @param origin The origin this screen was opened on
 * @param code The request code
 */
export function approveUrl(base: string | null, origin: string, code: string): string {
    return `${trimSlashes(base || origin)}/device#${code}`;
}

/**
 * Read the request code out of a location hash.
 * @param hash `window.location.hash`, with or without the leading "#"
 * @returns The code, or null when the hash is empty
 */
export function codeFromHash(hash: string): string | null {
    const code = hash.replace(/^#/, "");
    return code === "" ? null : code;
}

/**
 * Render text as an SVG QR code: dark modules on a white square with a quiet
 * zone, so it scans from a TV across a room.
 * @param text What the code carries
 */
export function qrSvg(text: string): string {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const size = count + QUIET_ZONE * 2;
    let path = "";
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) {
                path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
            }
        }
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
        `<rect width="${size}" height="${size}" fill="#fff"/>` +
        `<path d="${path}" fill="#000"/>` +
        `</svg>`
    );
}

/**
 * Whether the phone is reaching the instance by a different address than the
 * one the server is configured to publish. The approval still works, but the
 * phone should say so.
 */
export function hostMismatch(publicUrl: string | null, origin: string): boolean {
    return Boolean(publicUrl) && trimSlashes(publicUrl as string) !== trimSlashes(origin);
}
