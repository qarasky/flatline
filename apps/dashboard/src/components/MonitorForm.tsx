import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import {
    ApiError,
    createMonitor,
    fetchMonitorLinks,
    fetchMonitorTypes,
    replaceMonitorLinks,
    updateMonitor,
    type MonitorSummary,
} from "@/lib/api";
import {
    ALERT_THRESHOLD_FIELDS,
    COMMON_FIELDS,
    SCHEDULING_FIELDS,
    TYPE_SCHEMAS,
    defaultsFor,
    fieldsFor,
    schemaFor,
    type FieldDef,
} from "@/lib/monitor-schema";
import { PROVIDERS, resolveProvider } from "@/lib/providers";
import type { LinkCandidate } from "@/lib/links";
import { LinkPicker } from "@/components/WebsiteLinks";
import type { GroupOption } from "@/lib/groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Select sentinel that swaps the picker for free-text input. */
const CUSTOM_PROVIDER = "__custom__";

function FieldInput({
    field,
    value,
    onChange,
}: {
    field: FieldDef;
    value: unknown;
    onChange: (value: unknown) => void;
}) {
    if (field.kind === "boolean") {
        return (
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={Boolean(value ?? false)}
                    onChange={(e) => onChange(e.target.checked)}
                    className="size-3.5 accent-[var(--primary)]"
                />
                <span>{field.label}</span>
            </label>
        );
    }

    if (field.kind === "select") {
        return (
            <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{field.label}</span>
                <select
                    value={String(value ?? field.default ?? "")}
                    onChange={(e) => onChange(e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm"
                >
                    {(field.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    if (field.kind === "textarea") {
        return (
            <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">{field.label}</span>
                <textarea
                    value={typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={field.placeholder}
                    rows={3}
                    className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm"
                />
            </label>
        );
    }

    const inputType =
        field.kind === "number"
            ? "number"
            : field.kind === "password"
              ? "password"
              : field.kind === "url"
                ? "url"
                : "text";

    // list kind (e.g. accepted_statuscodes) is comma-separated text in the compact form.
    const displayValue =
        field.kind === "list"
            ? Array.isArray(value)
                ? (value as unknown[]).join(", ")
                : typeof value === "string"
                  ? value
                  : ""
            : typeof value === "number"
              ? String(value)
              : ((value as string) ?? "");

    return (
        <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {field.label}
                {field.required ? <span className="text-destructive"> *</span> : null}
            </span>
            <Input
                type={inputType}
                value={displayValue}
                placeholder={field.placeholder}
                required={field.required}
                onChange={(e) => {
                    if (field.kind === "number") {
                        const v = e.target.value;
                        onChange(v === "" ? undefined : Number(v));
                    } else if (field.kind === "list") {
                        onChange(
                            e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean)
                        );
                    } else {
                        onChange(e.target.value);
                    }
                }}
            />
            {field.help ? <span className="mt-1 block text-[11px] text-quiet">{field.help}</span> : null}
        </label>
    );
}

/**
 * Provider picker: the known catalog, or any domain typed by hand.
 *
 * The stored value is the raw id/domain — the server lowercases and trims it,
 * and the Superboard card resolves a logo. A value missing from the catalog
 * opens the free-text input pre-filled, so editing a monitor made through the
 * API keeps its provider visible instead of silently resetting it to none.
 */
function ProviderField({ value, onChange }: { value: unknown; onChange: (value: string | null) => void }) {
    const current = typeof value === "string" ? value : "";
    // Resolve first so an API-set spelling ("hetzner.com", "hetzner.de")
    // preselects the catalog entry instead of opening the free-text box.
    const resolved = resolveProvider(current);
    const knownId = resolved && !resolved.custom ? resolved.id : "";
    // Local "Other…" mode, not derived from the value: picking the option
    // must stay selected while the text box is still empty.
    const [customMode, setCustomMode] = useState(current !== "" && knownId === "");
    const [custom, setCustom] = useState(customMode ? current : "");

    return (
        <div>
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Provider</span>
            <div className="flex gap-2">
                <select
                    value={customMode ? CUSTOM_PROVIDER : knownId}
                    onChange={(e) => {
                        const next = e.target.value;
                        if (next === CUSTOM_PROVIDER) {
                            setCustomMode(true);
                            onChange(custom === "" ? null : custom);
                        } else {
                            setCustomMode(false);
                            onChange(next === "" ? null : next);
                        }
                    }}
                    className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm"
                >
                    <option value="">— none —</option>
                    {PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                    <option value={CUSTOM_PROVIDER}>Other…</option>
                </select>
                {customMode ? (
                    <Input
                        value={custom}
                        placeholder="domain, e.g. vultr.com"
                        aria-label="Custom provider domain"
                        onChange={(e) => {
                            setCustom(e.target.value);
                            onChange(e.target.value.trim() === "" ? null : e.target.value);
                        }}
                    />
                ) : null}
            </div>
            <span className="mt-1 block text-[11px] text-quiet">
                Symbol before the name on Superboard cards. Any domain works; unknown ones fall back to the site
                favicon.
            </span>
        </div>
    );
}

/**
 * Compact monitor form: type picker + universal basics + type basics.
 * Advanced lives behind a toggle and on a separate view by design.
 *
 * `groupChoices` turns the raw "parent" id field into a Group picker by
 * name; the caller passes the roster-derived options (already excluding the
 * edited group's own subtree, so a group can never move into itself).
 */
export function MonitorForm({
    initial,
    groupChoices,
    linkCandidates,
    onSaved,
    onCancel,
}: {
    initial?: (Partial<MonitorSummary> & Record<string, unknown>) | null;
    groupChoices?: GroupOption[];
    /** Groups and monitors offered as link targets when editing a server. */
    linkCandidates?: LinkCandidate[];
    onSaved: () => void;
    onCancel: () => void;
}) {
    const isEdit = Boolean(initial?.id);
    const [type, setType] = useState<string>(String((initial as any)?.type ?? "http"));
    const [values, setValues] = useState<Record<string, unknown>>(() => ({
        name: (initial as any)?.name ?? "",
        interval: (initial as any)?.interval ?? 60,
        active: (initial as any)?.active ?? true,
        ...defaultsFor(String((initial as any)?.type ?? "http")),
        ...(initial ?? {}),
    }));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [serverTypes, setServerTypes] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ignored, setIgnored] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    // Server monitors host websites. `linksReady` gates the link write on an
    // edit: if loading the existing links failed, saving must not wipe them.
    const linkable = Boolean(linkCandidates) && (type === "push" || type === "manual");
    const [linkSelection, setLinkSelection] = useState<Set<number>>(() => new Set());
    const [linksReady, setLinksReady] = useState(!isEdit);
    const [linkError, setLinkError] = useState<string | null>(null);

    useEffect(() => {
        fetchMonitorTypes()
            .then((r) => setServerTypes(Object.keys(r.types).sort()))
            .catch(() => setServerTypes(null));
    }, []);

    useEffect(() => {
        if (!isEdit || !linkable || !initial?.id) {
            setLinksReady(!isEdit);
            return;
        }
        let cancelled = false;
        fetchMonitorLinks(initial.id as number)
            .then((r) => {
                if (cancelled) {
                    return;
                }
                setLinkSelection(new Set(r.raw.map((link) => link.linkedMonitorId)));
                setLinksReady(true);
                setLinkError(null);
            })
            .catch((e) => {
                if (!cancelled) {
                    setLinkError(e instanceof Error ? e.message : "Could not load linked websites.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [isEdit, linkable, initial?.id]);

    // When the type changes on create, reset to that type's defaults.
    // On edit the type is locked (server rejects type changes).
    function handleTypeChange(next: string) {
        setType(next);
        if (!isEdit) {
            setValues({
                name: (values.name as string) ?? "",
                interval: 60,
                active: true,
                ...defaultsFor(next),
            });
        }
        setIgnored([]);
        setError(null);
    }

    function set(key: string, value: unknown) {
        setValues((prev) => ({ ...prev, [key]: value }));
    }

    /** Field writes go through here so the Group select stores an id. */
    function setField(field: FieldDef, value: unknown) {
        if (field.key === "parent") {
            // Clearing the picker must send null (leave the group), not
            // omit the key — a partial PATCH would keep the old parent.
            set("parent", value === "" || value == null ? null : Number(value));
            return;
        }
        set(field.key, value);
    }

    async function submit(event: SyntheticEvent) {
        event.preventDefault();
        setError(null);
        setIgnored([]);
        setSaving(true);

        // Strip empty strings/undefined so PATCH stays partial and POST
        // doesn't send junk. Name/type are always sent.
        const payload: Record<string, unknown> = { type };
        for (const [k, v] of Object.entries(values)) {
            if (v === undefined || v === "") {
                continue;
            }
            payload[k] = v;
        }

        // Thresholds are always sent, null when cleared: an empty field means
        // "disable this alert", and a partial PATCH that omitted the key
        // would silently keep the old value.
        for (const field of ALERT_THRESHOLD_FIELDS) {
            payload[field.key] = values[field.key] ?? null;
        }

        // Provider clears the same way: "none" must send null, not omit the
        // key. The server lowercases and trims it.
        payload.provider =
            typeof values.provider === "string" && values.provider.trim() !== ""
                ? values.provider.trim().toLowerCase()
                : null;

        try {
            let savedId: number | null = null;
            if (isEdit && initial?.id) {
                const res = await updateMonitor(initial.id, payload);
                setIgnored(res.ignoredFields ?? []);
                savedId = res.monitor.id ?? (initial.id as number);
            } else {
                const res = await createMonitor(payload);
                setIgnored(res.ignoredFields ?? []);
                savedId = res.monitor.id;
            }
            // Websites are a separate resource, written once the monitor
            // exists. On an edit, skip when the existing links never loaded so
            // a failed read cannot silently clear them.
            if (linkable && savedId != null && (!isEdit || linksReady)) {
                await replaceMonitorLinks(savedId, [...linkSelection]);
            }
            onSaved();
        } catch (e) {
            setError(
                e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Save failed."
            );
        } finally {
            setSaving(false);
        }
    }

    const schema = schemaFor(type);
    const basics = fieldsFor(type).filter(
        (f) => !f.advanced && f.key !== "name" && f.key !== "interval" && f.key !== "active"
    );
    const advanced = fieldsFor(type).filter((f) => f.advanced);
    const typeOptions = serverTypes ?? Object.keys(TYPE_SCHEMAS).sort();

    // The Group field is a picker over real group names when the caller
    // supplies the roster; without it the raw id input stays (API clients).
    const scheduling: FieldDef[] = SCHEDULING_FIELDS.map((field) =>
        field.key === "parent" && groupChoices
            ? {
                  ...field,
                  kind: "select" as const,
                  help: "Parent group. Pick a name, not an id.",
                  options: [{ value: "", label: "— none (top level)" }, ...groupChoices],
              }
            : field
    );

    return (
        <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                <label className="block">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground">Type</span>
                    <select
                        value={type}
                        disabled={isEdit}
                        onChange={(e) => handleTypeChange(e.target.value)}
                        className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-sm disabled:opacity-60"
                    >
                        {typeOptions.map((t) => (
                            <option key={t} value={t}>
                                {TYPE_SCHEMAS[t]?.label ?? t}
                            </option>
                        ))}
                    </select>
                </label>
                <div className="flex items-end pb-0.5 text-xs text-quiet">{schema.summary}</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                {COMMON_FIELDS.map((f) => (
                    <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f, v)} />
                ))}
                <ProviderField value={values.provider} onChange={(v) => set("provider", v)} />
            </div>

            {basics.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                    {basics.map((f) => (
                        <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f, v)} />
                    ))}
                </div>
            ) : null}

            <div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
                    {showAdvanced ? "Hide advanced" : "Show advanced"}
                </Button>
                {showAdvanced ? (
                    <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-border p-3 md:grid-cols-2">
                        {advanced.map((f) => (
                            <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f, v)} />
                        ))}
                        {scheduling
                            .filter((f) => !advanced.some((a) => a.key === f.key))
                            .map((f) => (
                                <FieldInput
                                    key={f.key}
                                    field={f}
                                    value={values[f.key]}
                                    onChange={(v) => setField(f, v)}
                                />
                            ))}
                        {advanced.length === 0 ? (
                            <p className="text-xs text-quiet md:col-span-2">
                                Scheduling and group options. Defaults are usually right.
                            </p>
                        ) : null}
                    </div>
                ) : null}
                {showAdvanced ? (
                    <div className="mt-3 rounded-md border border-border p-3">
                        <p className="mb-2 text-xs font-semibold tracking-wide text-quiet uppercase">
                            Metric alert thresholds
                        </p>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {ALERT_THRESHOLD_FIELDS.map((f) => (
                                <FieldInput
                                    key={f.key}
                                    field={f}
                                    value={values[f.key]}
                                    onChange={(v) => set(f.key, v)}
                                />
                            ))}
                        </div>
                        <p className="mt-2 text-xs text-quiet">
                            Push agents only. The server alerts when a value stays at or above its threshold for 60s,
                            repeats at most every 30 minutes, and declares recovery 5 points below. Empty disables.
                        </p>
                    </div>
                ) : null}
            </div>

            {linkable && linkCandidates ? (
                <div className="rounded-md border border-border p-3">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-quiet uppercase">Linked websites</p>
                    <LinkPicker
                        candidates={linkCandidates}
                        selected={linkSelection}
                        disabled={saving}
                        onToggle={(id) =>
                            setLinkSelection((prev) => {
                                const next = new Set(prev);
                                if (next.has(id)) {
                                    next.delete(id);
                                } else {
                                    next.add(id);
                                }
                                return next;
                            })
                        }
                    />
                    <p className="mt-2 text-xs text-quiet">
                        Their status appears on this server's Superboard card. Pick a group to include every website
                        inside it.
                    </p>
                    {linkError ? (
                        <p className="mt-2 text-xs text-bad" role="alert">
                            {linkError}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {ignored.length > 0 ? (
                <div className="rounded-md bg-warn/10 px-2.5 py-2 text-xs text-warn">
                    Server ignored unknown fields: {ignored.join(", ")}
                </div>
            ) : null}

            {error ? (
                <div className="rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">{error}</div>
            ) : null}

            <div className="flex gap-2">
                <Button type="submit" disabled={saving}>
                    {saving
                        ? "Saving…"
                        : isEdit
                          ? "Save changes"
                          : type === "group"
                            ? "Create group"
                            : "Create monitor"}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
