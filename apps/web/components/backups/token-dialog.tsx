"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * A freshly issued backup-agent token, shown once. Closing the dialog drops
 * it: nothing keeps it, and no endpoint returns it again.
 */
export function TokenDialog({ agentName, token, onClose }: { agentName: string; token: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    return (
        // Only Done closes it: a stray click or Esc must not lose a token shown once.
        <Dialog open>
            <DialogContent
                className="sm:max-w-lg"
                showCloseButton={false}
                onInteractOutside={(event) => event.preventDefault()}
                onEscapeKeyDown={(event) => event.preventDefault()}
            >
                <DialogHeader>
                    <DialogTitle>Token for {agentName}</DialogTitle>
                    <DialogDescription>
                        Put it in the agent&apos;s token file now. It is shown only this once; rotate the token to get a
                        new one.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex gap-2">
                    <Input
                        readOnly
                        value={token}
                        aria-label="Backup agent token"
                        className="font-mono text-xs"
                        onFocus={(e) => e.target.select()}
                    />
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label="Copy token"
                        onClick={() => {
                            // The clipboard API needs a secure origin; on plain http the field is there to select.
                            if (!navigator.clipboard) {
                                return;
                            }
                            void navigator.clipboard.writeText(token).then(() => setCopied(true));
                        }}
                    >
                        <Copy />
                    </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                    {copied ? "Copied. " : ""}It only opens <code>/api/backup/v1</code>; the operator API and the web
                    app refuse it.
                </p>
                <DialogFooter>
                    <Button onClick={onClose}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
