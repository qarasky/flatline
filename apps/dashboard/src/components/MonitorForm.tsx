import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { ApiError, createMonitor, fetchMonitorTypes, updateMonitor, type MonitorSummary } from "@/lib/api";
import { ALERT_THRESHOLD_FIELDS, COMMON_FIELDS, SCHEDULING_FIELDS, TYPE_SCHEMAS, defaultsFor, fieldsFor, schemaFor, type FieldDef } from "@/lib/monitor-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

    const inputType = field.kind === "number" ? "number" : field.kind === "password" ? "password" : field.kind === "url" ? "url" : "text";

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
 * Compact monitor form: type picker + universal basics + type basics.
 * Advanced lives behind a toggle and on a separate view by design.
 */
export function MonitorForm({
    initial,
    onSaved,
    onCancel,
}: {
    initial?: (MonitorSummary & Record<string, unknown>) | null;
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

    useEffect(() => {
        fetchMonitorTypes()
            .then((r) => setServerTypes(Object.keys(r.types).sort()))
            .catch(() => setServerTypes(null));
    }, []);

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

        try {
            if (isEdit && initial?.id) {
                const res = await updateMonitor(initial.id, payload);
                setIgnored(res.ignoredFields ?? []);
            } else {
                const res = await createMonitor(payload);
                setIgnored(res.ignoredFields ?? []);
            }
            onSaved();
        } catch (e) {
            setError(e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Save failed.");
        } finally {
            setSaving(false);
        }
    }

    const schema = schemaFor(type);
    const basics = fieldsFor(type).filter((f) => !f.advanced && f.key !== "name" && f.key !== "interval" && f.key !== "active");
    const advanced = fieldsFor(type).filter((f) => f.advanced);
    const typeOptions = serverTypes ?? Object.keys(TYPE_SCHEMAS).sort();

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
                    <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
                ))}
            </div>

            {basics.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                    {basics.map((f) => (
                        <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
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
                            <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
                        ))}
                        {SCHEDULING_FIELDS.filter((f) => !advanced.some((a) => a.key === f.key)).map((f) => (
                            <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
                        ))}
                        {advanced.length === 0 ? (
                            <p className="text-xs text-quiet md:col-span-2">Scheduling and group options. Defaults are usually right.</p>
                        ) : null}
                    </div>
                ) : null}
                {showAdvanced ? (
                    <div className="mt-3 rounded-md border border-border p-3">
                        <p className="mb-2 text-xs font-semibold tracking-wide text-quiet uppercase">Metric alert thresholds</p>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {ALERT_THRESHOLD_FIELDS.map((f) => (
                                <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
                            ))}
                        </div>
                        <p className="mt-2 text-xs text-quiet">
                            Push agents only. The server alerts when a value stays at or above its threshold for 60s,
                            repeats at most every 30 minutes, and declares recovery 5 points below. Empty disables.
                        </p>
                    </div>
                ) : null}
            </div>

            {ignored.length > 0 ? (
                <div className="rounded-md bg-warn/10 px-2.5 py-2 text-xs text-warn">
                    Server ignored unknown fields: {ignored.join(", ")}
                </div>
            ) : null}

            {error ? <div className="rounded-md bg-destructive/12 px-2.5 py-2 text-xs text-destructive">{error}</div> : null}

            <div className="flex gap-2">
                <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : isEdit ? "Save changes" : "Create monitor"}
                </Button>
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
