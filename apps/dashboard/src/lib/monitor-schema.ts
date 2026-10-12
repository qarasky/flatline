/**
 * Monitor field schemas.
 *
 * This replaces the upstream approach of one 4,600-line form with 173
 * `monitor.type === "..."` branches: every field lived in the DOM at once and
 * was toggled with v-if, so the three settings that matter most (interval,
 * retry interval, max retries) were buried below dozens of irrelevant inputs.
 *
 * Here a monitor type declares its fields as data, and the form renders from
 * that. Adding a type means adding an entry, not another branch.
 *
 * Field keys must match the `writableFields` list returned by
 * GET /api/v1/monitor-types; anything outside it is ignored by the server and
 * reported back in `ignoredFields`.
 */

export type FieldKind =
    | "text"
    | "number"
    | "password"
    | "url"
    | "select"
    | "boolean"
    | "textarea"
    | "list";

export interface FieldDef {
    /** API field name. */
    key: string;
    label: string;
    kind: FieldKind;
    required?: boolean;
    placeholder?: string;
    help?: string;
    options?: { value: string; label: string }[];
    /** Default applied when creating. */
    default?: unknown;
    /** Shown only under Advanced. */
    advanced?: boolean;
}

export interface TypeSchema {
    type: string;
    label: string;
    /** One-line description shown next to the type picker. */
    summary: string;
    /** Fields shown on the compact form. */
    basics: FieldDef[];
    /** Type-specific and rarely-touched fields. */
    advanced: FieldDef[];
    /** Whether this type supports response conditions. */
    supportsConditions?: boolean;
}

/** Fields every monitor has, regardless of type. */
export const COMMON_FIELDS: FieldDef[] = [
    { key: "name", label: "Name", kind: "text", required: true, placeholder: "Production API" },
    { key: "interval", label: "Check every", kind: "number", default: 60, help: "Seconds. Minimum 20." },
    { key: "active", label: "Enabled", kind: "boolean", default: true },
];

/** Scheduling fields, always advanced because defaults are usually right. */
export const SCHEDULING_FIELDS: FieldDef[] = [
    { key: "retryInterval", label: "Retry interval", kind: "number", help: "Seconds between retries when down.", advanced: true },
    { key: "maxretries", label: "Retries before alerting", kind: "number", default: 0, help: "0 alerts on the first failure.", advanced: true },
    { key: "resendInterval", label: "Re-notify every", kind: "number", default: 0, help: "Minutes. 0 disables.", advanced: true },
    { key: "timeout", label: "Timeout", kind: "number", help: "Seconds before the check is treated as failed.", advanced: true },
    { key: "upsideDown", label: "Invert status", kind: "boolean", help: "Alert when the service is UP instead of down.", advanced: true },
    { key: "parent", label: "Group", kind: "number", help: "Parent group monitor id.", advanced: true },
];

/**
 * Server-side metric alert thresholds (Superboard Phase 5). Push agents
 * only: values arrive with metrics. Empty disables. The server alerts when
 * the value stays at or above the threshold for 60 seconds and declares
 * recovery 5 points below it.
 */
export const ALERT_THRESHOLD_FIELDS: FieldDef[] = [
    { key: "metricCpuThreshold", label: "CPU %", kind: "number", placeholder: "90", help: "Sustained for 60s." },
    { key: "metricRamThreshold", label: "RAM %", kind: "number", placeholder: "90", help: "Sustained for 60s." },
    { key: "metricDiskThreshold", label: "Disk %", kind: "number", placeholder: "90", help: "Fullest mount, sustained for 60s." },
];

const HTTP_AUTH: FieldDef[] = [
    { key: "basic_auth_user", label: "Basic auth user", kind: "text", advanced: true },
    { key: "basic_auth_pass", label: "Basic auth password", kind: "password", advanced: true },
    { key: "bearer_token", label: "Bearer token", kind: "password", advanced: true },
];

/**
 * Schemas for the types that cover everyday use.
 *
 * Types without an entry fall back to a generic text field, so nothing is
 * impossible to create; they simply lack hand-written labels and grouping.
 */
export const TYPE_SCHEMAS: Record<string, TypeSchema> = {
    http: {
        type: "http",
        label: "HTTP(s)",
        summary: "Fetch a URL and check the response.",
        supportsConditions: true,
        basics: [
            { key: "url", label: "URL", kind: "url", required: true, placeholder: "https://example.com/health" },
            { key: "method", label: "Method", kind: "select", default: "GET",
              options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => ({ value: m, label: m })) },
            { key: "accepted_statuscodes", label: "Accept status codes", kind: "list", default: [ "200-299" ], help: "Ranges allowed. Anything else is a failure." },
        ],
        advanced: [
            { key: "keyword", label: "Keyword must appear", kind: "text", advanced: true },
            { key: "invertKeyword", label: "Keyword must NOT appear", kind: "boolean", advanced: true },
            { key: "jsonPath", label: "JSON path", kind: "text", advanced: true, placeholder: "$.status" },
            { key: "expectedValue", label: "Expected value", kind: "text", advanced: true },
            { key: "headers", label: "Headers", kind: "textarea", advanced: true, help: "One per line: Name: value" },
            { key: "body", label: "Request body", kind: "textarea", advanced: true },
            { key: "checkCertExpiry", label: "Notify on certificate expiry", kind: "boolean", advanced: true },
            { key: "ignoreTls", label: "Ignore TLS errors", kind: "boolean", advanced: true },
            { key: "maxredirects", label: "Max redirects", kind: "number", default: 10, advanced: true },
            ...HTTP_AUTH,
        ],
    },

    port: {
        type: "port",
        label: "TCP port",
        summary: "Open a TCP connection to a host and port.",
        basics: [
            { key: "hostname", label: "Hostname", kind: "text", required: true, placeholder: "db.internal" },
            { key: "port", label: "Port", kind: "number", required: true, placeholder: "5432" },
        ],
        advanced: [],
    },

    ping: {
        type: "ping",
        label: "Ping",
        summary: "ICMP echo to a host.",
        basics: [
            { key: "hostname", label: "Hostname", kind: "text", required: true, placeholder: "1.1.1.1" },
        ],
        advanced: [
            { key: "packetSize", label: "Packet size", kind: "number", default: 56, advanced: true },
        ],
    },

    dns: {
        type: "dns",
        label: "DNS",
        summary: "Resolve a record and check the answer.",
        supportsConditions: true,
        basics: [
            { key: "hostname", label: "Hostname", kind: "text", required: true, placeholder: "example.com" },
            { key: "dns_resolve_type", label: "Record type", kind: "select", default: "A",
              options: [ "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV", "CAA", "PTR" ].map((v) => ({ value: v, label: v })) },
        ],
        advanced: [
            { key: "dns_resolve_server", label: "Resolve using", kind: "text", default: "1.1.1.1", advanced: true },
            { key: "port", label: "Port", kind: "number", default: 53, advanced: true },
        ],
    },

    keyword: {
        type: "keyword",
        label: "HTTP(s) keyword",
        summary: "Fetch a URL and require a keyword in the body.",
        basics: [
            { key: "url", label: "URL", kind: "url", required: true, placeholder: "https://example.com" },
            { key: "keyword", label: "Keyword", kind: "text", required: true, placeholder: "healthy" },
        ],
        advanced: [
            { key: "invertKeyword", label: "Keyword must NOT appear", kind: "boolean", advanced: true },
            { key: "ignoreTls", label: "Ignore TLS errors", kind: "boolean", advanced: true },
            ...HTTP_AUTH,
        ],
    },

    group: {
        type: "group",
        label: "Group",
        summary: "A folder for other monitors. Not checked itself.",
        basics: [
            { key: "name", label: "Group name", kind: "text", required: true, placeholder: "Client A" },
        ],
        advanced: [],
    },

    manual: {
        type: "manual",
        label: "Manual / push",
        summary: "Nothing is checked. Status is reported by an external call.",
        basics: [
            { key: "name", label: "Name", kind: "text", required: true },
        ],
        advanced: [
            { key: "pushToken", label: "Push token", kind: "text", advanced: true, help: "POST to /api/push/<token> to report." },
        ],
    },
};

/**
 * Types with a hand-written schema.
 */
export function hasSchema(type: string): boolean {
    return type in TYPE_SCHEMAS;
}

/**
 * Schema for a type, falling back to a permissive generic one.
 *
 * The fallback exists so a type without a hand-written schema is still
 * creatable; it just asks for the essentials without labels or grouping.
 * @param type Monitor type
 * @returns The schema to render
 */
export function schemaFor(type: string): TypeSchema {
    if (TYPE_SCHEMAS[type]) {
        return TYPE_SCHEMAS[type];
    }

    return {
        type,
        label: type,
        summary: "No hand-written schema yet; the essentials are shown.",
        basics: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "hostname", label: "Hostname", kind: "text" },
            { key: "port", label: "Port", kind: "number" },
            { key: "url", label: "URL", kind: "url" },
        ],
        advanced: [],
    };
}

/**
 * Every field for a type, basics first then advanced, without duplicates and
 * without re-asking for name/interval/enabled which the shell renders once.
 */
export function fieldsFor(type: string): FieldDef[] {
    const schema = schemaFor(type);
    const seen = new Set<string>();
    const out: FieldDef[] = [];

    for (const field of [ ...schema.basics, ...schema.advanced ]) {
        if (seen.has(field.key)) {
            continue;
        }
        seen.add(field.key);
        out.push(field);
    }

    return out;
}

/**
 * Reset a form's values to the schema defaults for a type.
 * @param type Monitor type
 * @returns Initial values
 */
export function defaultsFor(type: string): Record<string, unknown> {
    const values: Record<string, unknown> = {};

    for (const field of fieldsFor(type)) {
        if (field.default !== undefined) {
            values[field.key] = field.default;
        }
    }

    return values;
}
