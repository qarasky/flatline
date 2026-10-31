"use client";

import { SelfReloadingError } from "@/components/self-reloading-error";

export default function StatusError() {
    return <SelfReloadingError what="This status page" />;
}
