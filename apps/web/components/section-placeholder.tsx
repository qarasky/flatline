/** Stands in for a section until its part of the rewrite lands. */
export function SectionPlaceholder({ title, part }: { title: string; part: number }) {
    return (
        <div className="flex flex-1 items-center justify-center p-10">
            <p className="text-muted-foreground">
                {title} moves here in part {part} of the rewrite.
            </p>
        </div>
    );
}
