import type { Metadata } from "next";

import { DeviceApprove } from "@/components/device/device-approve";

export const metadata: Metadata = { title: "Approve a screen · Flatline" };

export default function DevicePage() {
    return <DeviceApprove />;
}
