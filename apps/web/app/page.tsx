import { redirect } from "next/navigation";

import { HOME_PATH } from "@/lib/session";

export default function Root() {
    redirect(HOME_PATH);
}
