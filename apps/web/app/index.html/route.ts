export const dynamic = "force-dynamic";

/**
 * A wall screen still running the old Vite dashboard polls `/index.html` and
 * reloads when the module script it names differs from its own
 * (`/assets/index-<hash>.js`). This page names one the old build never had,
 * so the old tab reloads itself into this app. Someone who opens it is sent
 * to the root.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=/">
<title>Flatline</title>
<script type="module" src="/assets/flatline-next.js"></script>
</head>
<body><a href="/">Flatline</a></body>
</html>
`;

export function GET() {
    return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}
