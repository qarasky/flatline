import { BUILD_ID } from "@/lib/build-id";

export const dynamic = "force-dynamic";

/** The build this server runs; open tabs compare it with their own to notice a deploy. */
export function GET() {
    return Response.json({ build: BUILD_ID }, { headers: { "Cache-Control": "no-store" } });
}
