"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, Checkbox, Field, Input, Select, Textarea } from "@qarasky/kore-ui";

import { useBoardData } from "@/components/board/board-data";
import { ApiError } from "@/lib/api";
import { groupOptions } from "@/lib/groups";
import { buildLinkCandidates } from "@/lib/links";
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
import { buildMonitorPayload, notificationsToSend } from "@/lib/monitor-payload";
import type { MonitorSummary, NotificationSummary } from "@/lib/monitor-types";
import {
    createMonitor,
    fetchMonitorLinks,
    fetchMonitorTypes,
    fetchNotifications,
    replaceMonitorLinks,
    updateMonitor,
} from "@/lib/monitors-api";
import { PROVIDERS, resolveProvider } from "@/lib/providers";

import { LinkPicker } from "./link-picker";

/** Select value that swaps the provider picker for free text. */
const CUSTOM_PROVIDER = "__custom__";

export type FormInitial = Partial<MonitorSummary> & Record<string, unknown>;

/** Radix Select cannot hold an empty value: an empty option ("none") travels as this. */
const EMPTY_OPTION = "__none__";
const toSelect = (value: string) => (value === "" ? EMPTY_OPTION : value);
const fromSelect = (value: string) => (value === EMPTY_OPTION ? "" : value);

function FieldInput({
    field,
    value,
    onChange,
}: {
    field: FieldDef;
    value: unknown;
    onChange: (value: unknown) => void;
}) {
    const id = `field-${field.key}`;
    if (field.kind === "boolean") {
        return (
            <Checkbox
                id={id}
                checked={Boolean(value ?? false)}
                onCheckedChange={(c) => onChange(c === true)}
                label={field.label}
            />
        );
    }
    if (field.kind === "select") {
        return (
            <Field id={id} label={field.label} hint={field.help}>
                <Select
                    value={toSelect(String(value ?? field.default ?? ""))}
                    onValueChange={(next) => onChange(fromSelect(next))}
                    options={(field.options ?? []).map((o) => ({ value: toSelect(String(o.value)), label: o.label }))}
                />
            </Field>
        );
    }
    if (field.kind === "textarea") {
        return (
            <Field id={id} label={field.label} hint={field.help}>
                <Textarea
                    value={typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : ""}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={field.placeholder}
                    rows={3}
                />
            </Field>
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
    // A list (accepted status codes) is comma-separated text here.
    const shown =
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
        <Field id={id} label={field.label} hint={field.help} required={field.required}>
            <Input
                type={inputType}
                value={shown}
                placeholder={field.placeholder}
                onChange={(e) => {
                    if (field.kind === "number") {
                        onChange(e.target.value === "" ? undefined : Number(e.target.value));
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
        </Field>
    );
}

/**
 * Provider: the known catalog, or any domain typed by hand. A value missing
 * from the catalog opens the free-text box pre-filled, so a provider set
 * through the API stays visible instead of resetting to none.
 */
function ProviderField({ value, onChange }: { value: unknown; onChange: (value: string | null) => void }) {
    const current = typeof value === "string" ? value : "";
    const resolved = resolveProvider(current);
    const knownId = resolved && !resolved.custom ? resolved.id : "";
    const [customMode, setCustomMode] = useState(current !== "" && knownId === "");
    const [custom, setCustom] = useState(customMode ? current : "");
    return (
        <Field id="field-provider" label="Provider" hint="Shown before the name on Superboard cards.">
            <div className="flex gap-2">
                <Select
                    value={customMode ? CUSTOM_PROVIDER : toSelect(knownId)}
                    onValueChange={(next) => {
                        if (next === CUSTOM_PROVIDER) {
                            setCustomMode(true);
                            onChange(custom === "" ? null : custom);
                        } else {
                            setCustomMode(false);
                            const id = fromSelect(next);
                            onChange(id === "" ? null : id);
                        }
                    }}
                    options={[
                        { value: EMPTY_OPTION, label: "None" },
                        ...PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
                        { value: CUSTOM_PROVIDER, label: "Other…" },
                    ]}
                />
                {customMode ? (
                    <Input
                        id="field-provider-custom"
                        value={custom}
                        placeholder="vultr.com"
                        aria-label="Custom provider domain"
                        onChange={(e) => {
                            setCustom(e.target.value);
                            onChange(e.target.value.trim() === "" ? null : e.target.value);
                        }}
                    />
                ) : null}
            </div>
        </Field>
    );
}

/** Which notifications alert for this monitor. */
function NotificationsPicker({
    list,
    error,
    chosen,
    onToggle,
}: {
    list: NotificationSummary[] | null;
    error: string | null;
    chosen: Set<number>;
    onToggle: (id: number) => void;
}) {
    return (
        <fieldset className="rounded-ui border border-border p-3">
            <legend className="text-muted text-meta px-1 font-medium">Notifications</legend>
            {error ? (
                <p role="alert" className="text-warning text-meta">
                    {error} Saving leaves this monitor&apos;s notifications as they are.
                </p>
            ) : list === null ? (
                <p className="text-muted text-meta">Loading…</p>
            ) : list.length === 0 ? (
                <p className="text-muted text-meta">No notifications are set up yet.</p>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {list.map((n) => (
                        <label key={n.id} className="flex cursor-pointer items-center gap-2">
                            <Checkbox
                                checked={chosen.has(n.id)}
                                onCheckedChange={() => onToggle(n.id)}
                                aria-label={`Notify through ${n.name}`}
                            />
                            <span className="min-w-0 flex-1 truncate">{n.name}</span>
                            <span className="text-muted text-2xs">
                                {n.type}
                                {n.active ? "" : " · off"}
                            </span>
                        </label>
                    ))}
                </div>
            )}
        </fieldset>
    );
}

function toggled(set: Set<number>, id: number): Set<number> {
    const next = new Set(set);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}

/**
 * The monitor form for every type: create (in a dialog) and edit (in the
 * peek panel or on the full page). Basics first, the rest behind "Show
 * advanced". Websites (servers only) and notifications are written with
 * the monitor; either one is left alone when it could not be loaded.
 */
export function MonitorForm({
    initial,
    onSaved,
    onCancel,
}: {
    /** The monitor being edited (with an id), or create presets such as `parent`. */
    initial?: FormInitial | null;
    onSaved: (id: number) => void;
    onCancel: () => void;
}) {
    const { monitors } = useBoardData();
    const editId = typeof initial?.id === "number" ? initial.id : null;
    const isEdit = editId !== null;
    const [type, setType] = useState<string>(String(initial?.type ?? "http"));
    const [values, setValues] = useState<Record<string, unknown>>(() => ({
        name: initial?.name ?? "",
        interval: initial?.interval ?? 60,
        active: initial?.active ?? true,
        ...defaultsFor(String(initial?.type ?? "http")),
        ...(initial ?? {}),
    }));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [serverTypes, setServerTypes] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ignored, setIgnored] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    // Servers host websites. `linksReady` gates the write on an edit: if the
    // existing links failed to load, saving must not wipe them.
    const linkable = type === "push" || type === "manual";
    const [linkSelection, setLinkSelection] = useState<Set<number>>(() => new Set());
    const [linksReady, setLinksReady] = useState(!isEdit);
    const [linkError, setLinkError] = useState<string | null>(null);

    // The same rule for notifications: only a loaded list is written back.
    const [notifications, setNotifications] = useState<NotificationSummary[] | null>(null);
    const [notifyError, setNotifyError] = useState<string | null>(null);
    const [chosen, setChosen] = useState<Set<number>>(() => new Set());
    const knownLinks = Array.isArray(initial?.notificationIds) ? (initial.notificationIds as number[]) : null;

    const groupChoices = useMemo(
        () => groupOptions(monitors, type === "group" ? editId : null),
        [monitors, type, editId]
    );
    const linkCandidates = useMemo(() => buildLinkCandidates(monitors, editId), [monitors, editId]);

    useEffect(() => {
        fetchMonitorTypes()
            .then((r) => setServerTypes(Object.keys(r.types).sort()))
            .catch(() => setServerTypes(null));
    }, []);

    useEffect(() => {
        let cancelled = false;
        fetchNotifications()
            .then((list) => {
                if (cancelled) {
                    return;
                }
                if (isEdit && knownLinks === null) {
                    setNotifyError("Could not tell which notifications this monitor uses.");
                    return;
                }
                setNotifications(list);
                setChosen(new Set(isEdit ? knownLinks : list.filter((n) => n.isDefault).map((n) => n.id)));
            })
            .catch((e) => {
                if (!cancelled) {
                    setNotifyError(e instanceof Error ? `${e.message}` : "Could not load the notifications.");
                }
            });
        return () => {
            cancelled = true;
        };
        // Runs once per form: the initial links are what the form opened with.
    }, []);

    useEffect(() => {
        if (!isEdit || !linkable || editId === null) {
            setLinksReady(!isEdit);
            return;
        }
        let cancelled = false;
        fetchMonitorLinks(editId)
            .then((r) => {
                if (!cancelled) {
                    setLinkSelection(new Set(r.raw.map((link) => link.linkedMonitorId)));
                    setLinksReady(true);
                    setLinkError(null);
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setLinkError(e instanceof Error ? e.message : "Could not load linked websites.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [isEdit, linkable, editId]);

    // A new type on create resets to that type's defaults; on edit the type is locked.
    function handleTypeChange(next: string) {
        setType(next);
        if (!isEdit) {
            setValues((prev) => ({
                name: (prev.name as string) ?? "",
                interval: 60,
                active: true,
                parent: prev.parent,
                ...defaultsFor(next),
            }));
        }
        setIgnored([]);
        setError(null);
    }

    function set(key: string, value: unknown) {
        setValues((prev) => ({ ...prev, [key]: value }));
    }

    /** The Group picker stores an id; clearing it must send null (leave the group). */
    function setField(field: FieldDef, value: unknown) {
        if (field.key === "parent") {
            set("parent", value === "" || value == null ? null : Number(value));
            return;
        }
        set(field.key, value);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        setIgnored([]);
        setSaving(true);
        const payload = buildMonitorPayload(type, values, notificationsToSend(type, notifications !== null, chosen));
        try {
            let savedId: number;
            if (editId !== null) {
                const res = await updateMonitor(editId, payload);
                setIgnored(res.ignoredFields ?? []);
                savedId = res.monitor.id ?? editId;
            } else {
                const res = await createMonitor(payload);
                setIgnored(res.ignoredFields ?? []);
                savedId = res.monitor.id;
            }
            // Websites are a separate resource, written once the monitor exists.
            if (linkable && (!isEdit || linksReady)) {
                await replaceMonitorLinks(savedId, [...linkSelection]);
            }
            onSaved(savedId);
        } catch (e) {
            setError(
                e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : "Save failed."
            );
        } finally {
            setSaving(false);
        }
    }

    const schema = schemaFor(type);
    const basics = fieldsFor(type).filter((f) => !f.advanced && !["name", "interval", "active"].includes(f.key));
    const advanced = fieldsFor(type).filter((f) => f.advanced);
    const typeOptions = serverTypes ?? Object.keys(TYPE_SCHEMAS).sort();
    const scheduling: FieldDef[] = SCHEDULING_FIELDS.map((field) =>
        field.key === "parent"
            ? {
                  ...field,
                  kind: "select" as const,
                  help: "The group this monitor sits in.",
                  options: [{ value: "", label: "None (top level)" }, ...groupChoices],
              }
            : field
    );
    // The group is a common choice when creating inside one; keep it visible.
    const parentField = scheduling.find((f) => f.key === "parent") as FieldDef;

    return (
        <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                <Field id="field-type" label="Type">
                    <Select
                        value={type}
                        disabled={isEdit}
                        onValueChange={handleTypeChange}
                        options={typeOptions.map((t) => ({ value: t, label: TYPE_SCHEMAS[t]?.label ?? t }))}
                    />
                </Field>
                <p className="text-muted text-meta flex items-end pb-2">{schema.summary}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
                {COMMON_FIELDS.map((f) => (
                    <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f, v)} />
                ))}
                <ProviderField value={values.provider} onChange={(v) => set("provider", v)} />
                <FieldInput
                    field={parentField}
                    value={values.parent ?? ""}
                    onChange={(v) => setField(parentField, v)}
                />
            </div>
            {basics.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                    {basics.map((f) => (
                        <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setField(f, v)} />
                    ))}
                </div>
            ) : null}
            {type === "push" ? (
                <p className="text-muted text-meta">
                    For an agent host, set the interval to at least 3× the agent&apos;s push interval, with 2 retries
                    every 180 s, so a network blip reads as pending instead of paging.
                </p>
            ) : null}
            {type !== "group" ? (
                <NotificationsPicker
                    list={notifications}
                    error={notifyError}
                    chosen={chosen}
                    onToggle={(id) => setChosen((prev) => toggled(prev, id))}
                />
            ) : null}
            {linkable ? (
                <fieldset className="rounded-ui border border-border p-3">
                    <legend className="text-muted text-meta px-1 font-medium">Linked websites</legend>
                    <LinkPicker
                        candidates={linkCandidates}
                        selected={linkSelection}
                        disabled={saving}
                        onToggle={(id) => setLinkSelection((prev) => toggled(prev, id))}
                    />
                    <p className="text-muted text-meta mt-2">
                        Their status appears on this server&apos;s Superboard card. A group includes every website in
                        it.
                    </p>
                    {linkError ? (
                        <p className="text-danger text-meta mt-2" role="alert">
                            {linkError} Saving leaves the linked websites as they are.
                        </p>
                    ) : null}
                </fieldset>
            ) : null}
            <div>
                <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
                    {showAdvanced ? "Hide advanced" : "Show advanced"}
                </Button>
                {showAdvanced ? (
                    <>
                        <div className="mt-3 grid grid-cols-1 gap-3 rounded-ui border border-border p-3 md:grid-cols-2">
                            {advanced.map((f) => (
                                <FieldInput
                                    key={f.key}
                                    field={f}
                                    value={values[f.key]}
                                    onChange={(v) => setField(f, v)}
                                />
                            ))}
                            {scheduling
                                .filter((f) => f.key !== "parent" && !advanced.some((a) => a.key === f.key))
                                .map((f) => (
                                    <FieldInput
                                        key={f.key}
                                        field={f}
                                        value={values[f.key]}
                                        onChange={(v) => setField(f, v)}
                                    />
                                ))}
                        </div>
                        <div className="mt-3 rounded-ui border border-border p-3">
                            <p className="text-muted text-meta mb-2 font-medium">Metric alert thresholds</p>
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
                            <p className="text-muted text-meta mt-2">
                                Push agents only. The server alerts when a value stays at or above its threshold for 60
                                s, repeats at most every 30 minutes, and declares recovery 5 points below. Empty
                                disables.
                            </p>
                        </div>
                    </>
                ) : null}
            </div>
            {ignored.length > 0 ? (
                <p className="bg-warning/10 text-warning text-meta rounded-ui px-2.5 py-2">
                    The server ignored unknown fields: {ignored.join(", ")}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="bg-danger/10 text-danger text-meta rounded-ui px-2.5 py-2">
                    {error}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                <Button onClick={onCancel}>Cancel</Button>
                <Button type="submit" variant="primary" loading={saving}>
                    {saving
                        ? "Saving…"
                        : isEdit
                          ? "Save changes"
                          : type === "group"
                            ? "Create group"
                            : "Create monitor"}
                </Button>
            </div>
        </form>
    );
}
