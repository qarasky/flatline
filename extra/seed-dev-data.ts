/*
 * Dev-only seeder for local development.
 *
 * Creates one open page (with a client accent colour and a realistic beat
 * history) and one password-protected page, so both rendering paths and the
 * unlock flow can be exercised locally.
 */
import { auth } from "../server/better-auth";
// @ts-ignore
import TestDB from "../test/mock-testdb";

const testDb = new TestDB();

async function main() {
    testDb.dataDir = process.argv[2];
    await testDb.create();
    await auth();

    const user = await auth().api.createUser({
        body: {
            name: "skyler",
            email: "skyler@noreply.uptime-kuma.internal",
            password: "Flatline-Demo-Pass-1",
            role: "admin",
            data: { username: "skyler" },
        },
    });

    const { R } = require("redbean-node");
    const statusPageAuth = require("../server/status-page-auth");
    const uid = user.user.id;
    const now = Date.now();

    const beat = async (monitorID: number, status: number, minsAgo: number, ping: number) => {
        const time = new Date(now - minsAgo * 60000).toISOString().slice(0, 19).replace("T", " ");
        await R.exec(
            "INSERT INTO heartbeat (monitor_id, status, time, msg, ping, important) VALUES (?,?,?,?,?,1)",
            [ monitorID, status, time, status === 0 ? "connection refused" : "OK", ping ]
        );
    };

    const monitor = async (name: string, url: string) => {
        const bean = R.dispense("monitor");
        bean.user_id = uid;
        bean.name = name;
        bean.type = "http";
        bean.url = url;
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.timeout = 48;
        // Inactive: an active monitor starts a check loop whose timers outlive
        // the seeder process.
        bean.active = 0;
        await R.store(bean);
        return bean;
    };

    const page = async (fields: any) => {
        const bean = R.dispense("status_page");
        bean.icon = "";
        bean.theme = "auto";
        bean.published = 1;
        bean.show_powered_by = 0;
        bean.auto_refresh_interval = 0;
        Object.assign(bean, fields);
        await R.store(bean);
        return bean;
    };

    const section = async (pageID: number, name: string, monitors: any[]) => {
        const group = R.dispense("group");
        group.status_page_id = pageID;
        group.name = name;
        group.public = 1;
        group.active = 1;
        await R.store(group);

        for (const m of monitors) {
            await R.exec(
                "INSERT INTO monitor_group (monitor_id, group_id, weight, send_url) VALUES (?,?,0,0)",
                [ m.id, group.id ]
            );
        }
        return group;
    };

    // Open page with a blue client accent and an incident in the history.
    const northwind = await page({
        title: "Northwind Cloud",
        slug: "northwind",
        description: "Live availability for Northwind Cloud services.",
        accentColor: "#1E40AF",
    });

    const edge = await monitor("Edge API", "https://edge.northwind.example");
    const dash = await monitor("Dashboard", "https://dash.northwind.example");

    for (const m of [ edge, dash ]) {
        for (let i = 0; i < 40; i++) {
            // A short outage window on the edge service gives the beat bar shape.
            const down = m.id === edge.id && i >= 30 && i <= 33;
            await beat(m.id, down ? 0 : 1, i * 30, 80 + ((i * 13) % 70));
        }
    }

    await section(northwind.id, "Core services", [ edge, dash ]);

    const incident = R.dispense("incident");
    incident.status_page_id = northwind.id;
    incident.title = "Elevated error rate on Edge API";
    incident.content =
        "We are investigating a spike in 5xx responses from the Edge API.\n\nA mitigation has been applied and error rates are returning to baseline.";
    incident.style = "warning";
    incident.active = 0;
    incident.pin = 1;
    incident.created_date = new Date(now - 26 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    incident.last_updated_date = new Date(now - 24 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    await R.store(incident);

    // Password-protected page, so the unlock flow is exercised too.
    const halberd = await page({
        title: "Halberd Systems",
        slug: "halberd",
        accentColor: "#7C3AED",
        password: await statusPageAuth.hashPassword("halberd-secret"),
    });

    await section(halberd.id, "Services", [ edge ]);
    for (let i = 0; i < 30; i++) {
        await beat(edge.id, 1, i * 30, 95);
    }

    // API tokens for exercising the dashboard: a full-access one and a
    // read-only one, so scope gating can be checked by hand too.
    const passwordHash = require("../server/password-hash");
    for (const [ name, secret, scopes ] of [
        [ "full", "tok-full", "read,write,publish" ],
        [ "read", "tok-read", "read" ],
    ]) {
        const key = R.dispense("api_key");
        key.key = await passwordHash.generate(secret);
        key.name = name;
        key.user_id = uid;
        key.active = 1;
        key.expires = null;
        key.scopes = scopes;
        await R.store(key);
    }

    console.log("seeded: /status/northwind (open), /status/halberd (halberd-secret)");
    console.log("tokens: uk1_tok-full (read+write+publish), uk2_tok-read (read)");
    process.exit(0);
}

main().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});