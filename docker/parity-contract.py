#!/usr/bin/env python3
"""Contract comparison: the Node backend and the Rust backend, served from
copies of the same database.

Both sides read the same imported history, so every read response can be
compared field by field. Live checks are neutralized by deactivating
monitors in the copies; the push contract, monitor create and API-key
lifecycle are exercised explicitly at the end and compared on both sides.

Usage:
    python3 docker/parity-contract.py --prod-db <kuma.db> \
        [--rust-bin backend-rs/target/debug/flatline-backend] \
        [--node-port 3990] [--rust-port 3991] [--workdir <dir>] [--keep]

Exit code 0 when every comparison passes.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fields the Node backend returns that the Rust surface deliberately does
# not carry (documented scope decisions, not regressions).
KNOWN_DIFFERENCES = {
    "tags": "tags are out of scope in v1; the production page has show_tags=0",
    "certExpiryDaysRemaining": "cert-expiry tracking is out of scope",
    "validCert": "cert-expiry tracking is out of scope",
    "sendUrl": "group send-url overrides are not part of the v1 monitor API",
}

UPTIME_TOLERANCE = 0.02  # absolute, on 0..1 ratios
PING_TOLERANCE = 0.001
STATS_TOLERANCE = 1e-6


class Report:
    def __init__(self):
        self.failures = []
        self.passes = 0

    def check(self, name, ok, detail=""):
        if ok:
            self.passes += 1
            print(f"  PASS  {name}")
        else:
            self.failures.append(name)
            print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))

    def compare(self, name, problems):
        self.check(name, not problems, "; ".join(problems))

    def info(self, name, detail):
        print(f"  INFO  {name} — {detail}")


class Client:
    def __init__(self, base, token=None):
        self.base = base.rstrip("/")
        self.token = token

    def request(self, method, path, body=None, token=None):
        url = self.base + path
        headers = {"Accept": "application/json"}
        token = self.token if token is None else token
        if token:
            headers["Authorization"] = "Bearer " + token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8", "replace")
                return response.status, parse_json(raw), dict(response.headers)
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            return error.code, parse_json(raw), dict(error.headers)
        except Exception as error:  # connection refused etc.
            return 0, {"error": str(error)}, {}


def parse_json(raw):
    try:
        return json.loads(raw)
    except Exception:
        return raw


def num_close(a, b, tolerance):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return abs(float(a) - float(b)) <= tolerance
    except (TypeError, ValueError):
        return False


def wait_for(client, name, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, _, _ = client.request("GET", "/api/v1/auth/setup")
        if status == 200:
            return True
        time.sleep(0.5)
    raise RuntimeError(f"{name} did not become ready in {timeout}s")


def sqlite_scalar(path, query, args=()):
    conn = sqlite3.connect(path)
    try:
        row = conn.execute(query, args).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def sqlite_exec(path, query, args=()):
    conn = sqlite3.connect(path)
    try:
        conn.execute(query, args)
        conn.commit()
    finally:
        conn.close()


def sqlite_rows(path, query, args=()):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(query, args).fetchall()
    finally:
        conn.close()


def compare_monitor(report, label, node, rust):
    problems = []
    for key, value in node.items():
        if key in KNOWN_DIFFERENCES:
            continue
        if key not in rust:
            problems.append(f"missing {key!r}")
            continue
        other = rust[key]
        if key == "uptime24h":
            if not num_close(value, other, UPTIME_TOLERANCE):
                problems.append(f"{key}: node={value} rust={other}")
        elif key in ("uptime7d", "uptime30d"):
            # Deliberate method difference: Node's stat tables ignore gaps
            # in the heartbeat history, the Rust extends the last status
            # through them (dead-man). Reported, not compared.
            if value is not None and other is not None and abs(float(value) - float(other)) > UPTIME_TOLERANCE:
                report.info(f"{label} {key}", f"node={value} rust={other} (gap semantics)")
        elif key == "ping":
            if not num_close(value, other, PING_TOLERANCE):
                problems.append(f"{key}: node={value} rust={other}")
        elif value != other:
            problems.append(f"{key}: node={value!r} rust={other!r}")
    report.compare(label, problems)


def compare_beat_lists(report, label, node_beats, rust_beats):
    problems = []
    if len(node_beats) != len(rust_beats):
        problems.append(f"count: node={len(node_beats)} rust={len(rust_beats)}")
    for index, (n, r) in enumerate(zip(node_beats, rust_beats)):
        for key in ("time", "status", "ping", "msg", "important"):
            if n.get(key) != r.get(key):
                problems.append(f"[{index}].{key}: node={n.get(key)!r} rust={r.get(key)!r}")
        if problems:
            break
    report.compare(label, problems)


def compare_stats(report, label, node_stats, rust_stats):
    problems = []
    for metric in ("cpu", "ram", "gpu", "vram"):
        n = (node_stats or {}).get(metric)
        r = (rust_stats or {}).get(metric)
        if (n is None) != (r is None):
            problems.append(f"{metric}: node={n} rust={r}")
            continue
        if n is None:
            continue
        for key in ("count", "min", "max", "mean", "p90", "p95", "p99"):
            if key == "count":
                if n[key] != r[key]:
                    problems.append(f"{metric}.count: node={n[key]} rust={r[key]}")
            elif not num_close(n[key], r[key], STATS_TOLERANCE):
                problems.append(f"{metric}.{key}: node={n[key]} rust={r[key]}")
    report.compare(label, problems)


def badge_aria(svg):
    if not isinstance(svg, str):
        return None
    marker = 'aria-label="'
    start = svg.find(marker)
    if start < 0:
        return None
    end = svg.find('"', start + len(marker))
    return svg[start + len(marker):end]


def badge_message_number(aria):
    if not aria or ":" not in aria:
        return None
    message = aria.split(":", 1)[1].strip()
    number = ""
    for char in message:
        if char.isdigit() or char == ".":
            number += char
        else:
            break
    try:
        return float(number)
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prod-db", required=True, help="production database copy")
    parser.add_argument("--rust-bin", default="backend-rs/target/debug/flatline-backend")
    parser.add_argument("--node-port", type=int, default=3990)
    parser.add_argument("--rust-port", type=int, default=3991)
    parser.add_argument("--workdir", default="/tmp/flatline-parity")
    parser.add_argument("--keep", action="store_true", help="keep the workdir and logs")
    args = parser.parse_args()

    workdir = os.path.abspath(args.workdir)
    shutil.rmtree(workdir, ignore_errors=True)
    node_data = os.path.join(workdir, "node", "data")
    rust_data = os.path.join(workdir, "rust", "data")
    os.makedirs(node_data)
    os.makedirs(rust_data)
    node_db = os.path.join(node_data, "kuma.db")
    shutil.copyfile(args.prod_db, node_db)

    # Quiesce the copies: no live checks, no notifications, and no
    # duplicate alerts while two backends share the fleet's history.
    sqlite_exec(node_db, "UPDATE monitor SET active = 0")
    sqlite_exec(node_db, "UPDATE notification SET active = 0")

    # A known API token for the Node side. The Node scheme is
    # `uk<id>_<secret>` with only the secret half hashed (via the repo's
    # own module), scoped to a real account: resolveAPIKey also checks the
    # owner exists and is not banned.
    user_id = sqlite_scalar(node_db, "SELECT id FROM better_auth_user WHERE banned = 0 LIMIT 1") or "1"
    token = "uk9001_paritycontract"
    hash_script = (
        "require('./server/password-hash').generate(process.argv[1])"
        ".then(h => console.log(h))"
    )
    node_hash = subprocess.check_output(
        ["node", "-e", hash_script, "paritycontract"],
        cwd=REPO,
        text=True,
    ).strip()
    sqlite_exec(
        node_db,
        "INSERT INTO api_key (id, user_id, key, name, active, created_date, scopes) "
        "VALUES (9001, ?, ?, 'parity', 1, datetime('now'), 'read,write,publish')",
        (user_id, node_hash),
    )

    node_log = open(os.path.join(workdir, "node.log"), "w")
    rust_log = open(os.path.join(workdir, "rust.log"), "w")
    node_process = None
    rust_process = None
    report = Report()

    try:
        node_process = subprocess.Popen(
            ["node", "--import=tsx", "server/server.js"],
            cwd=REPO,
            env=dict(os.environ, DATA_DIR=node_data, PORT=str(args.node_port)),
            stdout=node_log,
            stderr=subprocess.STDOUT,
        )
        node = Client(f"http://127.0.0.1:{args.node_port}", token)
        wait_for(node, "node backend")

        # Import the same database into the Rust schema.
        subprocess.check_call(
            [os.path.join(REPO, args.rust_bin), "import", "--from", node_db,
             "--data-dir", rust_data],
            cwd=REPO,
            stdout=subprocess.DEVNULL,
        )
        rust_token = open(os.path.join(rust_data, "initial-token.txt")).read().strip()

        rust_process = subprocess.Popen(
            [os.path.join(REPO, args.rust_bin)],
            cwd=REPO,
            env=dict(
                os.environ,
                DATA_DIR=rust_data,
                PORT=str(args.rust_port),
                FLATLINE_WEB_DIST=os.path.join(workdir, "no-web-build"),
            ),
            stdout=rust_log,
            stderr=subprocess.STDOUT,
        )
        rust = Client(f"http://127.0.0.1:{args.rust_port}", rust_token)
        wait_for(rust, "rust backend")

        print("== auth ==")
        node_status, node_body, _ = node.request("GET", "/api/v1/auth/setup")
        rust_status, rust_body, _ = rust.request("GET", "/api/v1/auth/setup")
        report.compare("auth/setup", [] if (node_status, node_body) == (rust_status, rust_body)
                       else [f"node={node_body} rust={rust_body}"])

        # Wrong credentials must fail identically on both sides. (The Rust
        # backend has no user accounts: its token is accepted as the
        # password — a documented difference from Node's user login.)
        node_status, _, _ = node.request("POST", "/api/v1/auth/login",
                                         {"username": "x", "password": "wrong"})
        rust_status, _, _ = rust.request("POST", "/api/v1/auth/login",
                                         {"username": "x", "password": "wrong"})
        report.check("auth/login wrong credentials 401", node_status == 401 and rust_status == 401,
                     f"node={node_status} rust={rust_status}")
        rust_status, rust_body, _ = rust.request("POST", "/api/v1/auth/login",
                                                 {"username": "x", "password": rust_token})
        report.check("rust token-as-password sign-in", rust_status == 200 and rust_body.get("ok") is True,
                     f"rust={rust_status}")

        report.check("auth required", node.request("GET", "/api/v1/health", token="")[0] == 401
                     and rust.request("GET", "/api/v1/health", token="")[0] == 401)

        print("== health ==")
        _, node_health, _ = node.request("GET", "/api/v1/health")
        _, rust_health, _ = rust.request("GET", "/api/v1/health")
        for key in ("total", "up", "down", "pending", "paused", "maintenance", "status"):
            report.check(f"health.{key}", node_health["health"][key] == rust_health["health"][key],
                         f"node={node_health['health'][key]} rust={rust_health['health'][key]}")
        node_down = sorted(m["id"] for m in node_health["health"]["downMonitors"])
        rust_down = sorted(m["id"] for m in rust_health["health"]["downMonitors"])
        report.check("health.downMonitors", node_down == rust_down,
                     f"node={node_down} rust={rust_down}")

        print("== monitors ==")
        _, node_list, _ = node.request("GET", "/api/v1/monitors?perPage=200")
        _, rust_list, _ = rust.request("GET", "/api/v1/monitors?perPage=200")
        report.check("monitors.total", node_list["pagination"]["total"] == rust_list["pagination"]["total"],
                     f"node={node_list['pagination']['total']} rust={rust_list['pagination']['total']}")
        report.check("monitors.count", node_list["count"] == rust_list["count"])
        rust_by_id = {m["id"]: m for m in rust_list["monitors"]}
        for node_monitor in node_list["monitors"]:
            compare_monitor(report, f"monitors[{node_monitor['id']}] {node_monitor['name']}",
                            node_monitor, rust_by_id.get(node_monitor["id"], {}))

        # Filters. Node's `?status=` filter compares the numeric status to
        # the string query and never matches (returns []); the Rust
        # implements the documented values. Verified as a documented
        # difference, and the Rust result is checked against the list.
        _, node_status_filter, _ = node.request("GET", "/api/v1/monitors?perPage=200&status=up")
        _, rust_status_filter, _ = rust.request("GET", "/api/v1/monitors?perPage=200&status=up")
        report.info("monitors?status=up",
                    f"node returns {len(node_status_filter['monitors'])} rows (broken filter), "
                    f"rust returns {len(rust_status_filter['monitors'])} (implemented)")
        rust_expected = sorted(m["id"] for m in rust_list["monitors"] if m["status"] == 1)
        report.check("monitors?status=up rust matches status",
                     sorted(m["id"] for m in rust_status_filter["monitors"]) == rust_expected)
        for query in ("active=true", "q=bes"):
            _, n, _ = node.request("GET", f"/api/v1/monitors?perPage=200&{query}")
            _, r, _ = rust.request("GET", f"/api/v1/monitors?perPage=200&{query}")
            report.check(f"monitors?{query} ids",
                         sorted(m["id"] for m in n["monitors"]) == sorted(m["id"] for m in r["monitors"]),
                         f"node={sorted(m['id'] for m in n['monitors'])} rust={sorted(m['id'] for m in r['monitors'])}")

        for monitor_id in (8, 12, 18, 46):
            _, node_one, _ = node.request("GET", f"/api/v1/monitors/{monitor_id}")
            _, rust_one, _ = rust.request("GET", f"/api/v1/monitors/{monitor_id}")
            compare_monitor(report, f"monitors/{monitor_id}", node_one["monitor"], rust_one["monitor"])

        node_404_status, _, _ = node.request("GET", "/api/v1/monitors/99999")
        rust_404_status, _, _ = rust.request("GET", "/api/v1/monitors/99999")
        report.check("monitors/unknown 404", node_404_status == 404 and rust_404_status == 404,
                     f"node={node_404_status} rust={rust_404_status}")

        print("== heartbeats ==")
        for monitor_id in (8, 12, 46):
            _, node_beats, _ = node.request("GET", f"/api/v1/monitors/{monitor_id}/heartbeats?limit=5")
            _, rust_beats, _ = rust.request("GET", f"/api/v1/monitors/{monitor_id}/heartbeats?limit=5")
            report.check(f"heartbeats[{monitor_id}].total",
                         node_beats["total"] == rust_beats["total"],
                         f"node={node_beats['total']} rust={rust_beats['total']}")
            report.check(f"heartbeats[{monitor_id}].limit", node_beats["limit"] == rust_beats["limit"])
            compare_beat_lists(report, f"heartbeats[{monitor_id}].rows",
                               node_beats["heartbeats"], rust_beats["heartbeats"])
        node_bad_status, _, _ = node.request("GET", "/api/v1/monitors/8/heartbeats?limit=abc")
        rust_bad_status, _, _ = rust.request("GET", "/api/v1/monitors/8/heartbeats?limit=abc")
        report.check("heartbeats bad limit 400", node_bad_status == 400 and rust_bad_status == 400,
                     f"node={node_bad_status} rust={rust_bad_status}")

        print("== metrics ==")
        ids = "8,12,46"
        _, node_bulk, _ = node.request("GET", f"/api/v1/monitors/metrics/latest?ids={ids}")
        _, rust_bulk, _ = rust.request("GET", f"/api/v1/monitors/metrics/latest?ids={ids}")
        for monitor_id in ("8", "12", "46"):
            n = node_bulk["samples"].get(monitor_id)
            r = rust_bulk["samples"].get(monitor_id)
            if n is None or r is None:
                report.check(f"metrics/latest[{monitor_id}]", n == r, f"node={n} rust={r}")
                continue
            problems = []
            if n.get("time") != r.get("time"):
                problems.append(f"time: node={n.get('time')} rust={r.get('time')}")
            if n.get("metrics") != r.get("metrics"):
                problems.append("metrics payload differs")
            report.compare(f"metrics/latest[{monitor_id}]", problems)

        _, node_one, _ = node.request("GET", "/api/v1/monitors/46/metrics/latest")
        _, rust_one, _ = rust.request("GET", "/api/v1/monitors/46/metrics/latest")
        report.compare("metrics/latest single", []
                       if (node_one.get("time"), node_one.get("metrics")) ==
                          (rust_one.get("time"), rust_one.get("metrics"))
                       else [f"node={node_one.get('time')} rust={rust_one.get('time')}"])

        _, node_summary, _ = node.request("GET", "/api/v1/monitors/46/metrics/summary?hours=1")
        _, rust_summary, _ = rust.request("GET", "/api/v1/monitors/46/metrics/summary?hours=1")
        report.check("summary.samples", node_summary["samples"] == rust_summary["samples"],
                     f"node={node_summary['samples']} rust={rust_summary['samples']}")
        report.check("summary.firstSample", node_summary["firstSample"] == rust_summary["firstSample"])
        report.check("summary.lastSample", node_summary["lastSample"] == rust_summary["lastSample"])
        report.check("summary.bucketSeconds", node_summary["bucketSeconds"] == rust_summary["bucketSeconds"])
        report.check("summary.series length", len(node_summary["series"]) == len(rust_summary["series"]))
        compare_stats(report, "summary.stats", node_summary["stats"], rust_summary["stats"])

        _, node_long, _ = node.request("GET", "/api/v1/monitors/46/metrics/summary?hours=200")
        _, rust_long, _ = rust.request("GET", "/api/v1/monitors/46/metrics/summary?hours=200")
        report.check("summary long tier samples", node_long["samples"] == rust_long["samples"],
                     f"node={node_long['samples']} rust={rust_long['samples']}")
        report.check("summary long tier basis", ("hourly" in node_long.get("basis", "")) ==
                     ("hourly" in rust_long.get("basis", "")))

        _, node_raw, _ = node.request("GET", "/api/v1/monitors/46/metrics?hours=24")
        _, rust_raw, _ = rust.request("GET", "/api/v1/monitors/46/metrics?hours=24")
        report.check("metrics raw count", node_raw["count"] == rust_raw["count"],
                     f"node={node_raw['count']} rust={rust_raw['count']}")
        if node_raw["metrics"] and rust_raw["metrics"]:
            report.check("metrics raw newest row",
                         node_raw["metrics"][0] == rust_raw["metrics"][0],
                         f"node={node_raw['metrics'][0]['time']} rust={rust_raw['metrics'][0]['time']}")

        print("== notifications & monitor types ==")
        _, node_notifications, _ = node.request("GET", "/api/v1/notifications")
        _, rust_notifications, _ = rust.request("GET", "/api/v1/notifications")
        report.check("notifications.count",
                     node_notifications["count"] == rust_notifications["count"],
                     f"node={node_notifications['count']} rust={rust_notifications['count']}")
        node_config = node_notifications["notifications"][0]["config"] if node_notifications["count"] else {}
        rust_config = rust_notifications["notifications"][0]["config"] if rust_notifications["count"] else {}
        report.check("notifications token redacted",
                     "telegramBotToken" not in node_config and "telegramBotToken" not in rust_config)

        print("== monitor types ==")
        # The Rust implements a deliberate subset; every type the fleet
        # actually uses must be supported, and Node's always-present
        # http/https/push must be too.
        _, node_types, _ = node.request("GET", "/api/v1/monitor-types")
        _, rust_types, _ = rust.request("GET", "/api/v1/monitor-types")
        used = {row[0] for row in sqlite_rows(node_db, "SELECT DISTINCT type FROM monitor")}
        missing = sorted(kind for kind in used if kind not in rust_types["types"])
        report.check("monitor-types cover the fleet", not missing, f"unsupported: {missing}")
        report.check("monitor-types core set",
                     all(kind in rust_types["types"] for kind in ("http", "https", "push")))
        report.info("monitor-types scope",
                    f"node advertises {len(node_types['types'])} types, rust {len(rust_types['types'])} "
                    f"(locked subset; rust-only: {sorted(set(rust_types['types']) - set(node_types['types']))})")

        print("== status pages ==")
        _, node_page, _ = node.request("GET", "/api/status-page/clients")
        _, rust_page, _ = rust.request("GET", "/api/status-page/clients")
        config_problems = []
        for key, value in node_page["config"].items():
            if key not in rust_page["config"]:
                config_problems.append(f"missing {key!r}")
            elif value != rust_page["config"][key]:
                config_problems.append(f"{key}: node={value!r} rust={rust_page['config'][key]!r}")
        report.compare("status-page config", config_problems)
        node_groups = [(g["name"], g["weight"], [(m["id"], m["name"], m["type"]) for m in g["monitorList"]])
                       for g in node_page["publicGroupList"]]
        rust_groups = [(g["name"], g["weight"], [(m["id"], m["name"], m["type"]) for m in g["monitorList"]])
                       for g in rust_page["publicGroupList"]]
        report.check("status-page groups", node_groups == rust_groups,
                     f"node={node_groups[:1]} rust={rust_groups[:1]}")

        _, node_beats, _ = node.request("GET", "/api/status-page/heartbeat/clients")
        _, rust_beats, _ = rust.request("GET", "/api/status-page/heartbeat/clients")
        report.check("status-page heartbeat keys",
                     sorted(node_beats["heartbeatList"]) == sorted(rust_beats["heartbeatList"]))
        beat_problems = []
        for key, beats in node_beats["heartbeatList"].items():
            other = rust_beats["heartbeatList"].get(key, [])
            if len(beats) != len(other):
                beat_problems.append(f"{key}: count node={len(beats)} rust={len(other)}")
                continue
            if [b["status"] for b in beats] != [b["status"] for b in other]:
                beat_problems.append(f"{key}: statuses differ")
        report.compare("status-page heartbeat statuses", beat_problems)
        uptime_problems = []
        for key, value in node_beats["uptimeList"].items():
            if not num_close(value, rust_beats["uptimeList"].get(key), UPTIME_TOLERANCE):
                uptime_problems.append(f"{key}: node={value} rust={rust_beats['uptimeList'].get(key)}")
        report.compare("status-page uptime24", uptime_problems)

        _, node_history, _ = node.request("GET", "/api/status-page/clients/incident-history")
        _, rust_history, _ = rust.request("GET", "/api/status-page/clients/incident-history")
        report.check("incident-history total", node_history["total"] == rust_history["total"])
        report.check("incident-history hasMore", node_history["hasMore"] == rust_history["hasMore"])

        _, node_host, _ = node.request("GET", "/api/status-page/resolve-host?host=status.clients.kz")
        _, rust_host, _ = rust.request("GET", "/api/status-page/resolve-host?host=status.clients.kz")
        report.check("resolve-host", node_host == rust_host, f"node={node_host} rust={rust_host}")

        print("== badges ==")
        for path, label in (
            ("/api/badge/8/status", "badge status"),
            ("/api/badge/8/uptime", "badge uptime"),
            ("/api/badge/8/ping", "badge ping"),
            ("/api/badge/8/response", "badge response"),
            ("/api/badge/8/avg-response", "badge avg-response"),
        ):
            _, node_svg, _ = node.request("GET", path)
            _, rust_svg, _ = rust.request("GET", path)
            node_aria = badge_aria(node_svg)
            rust_aria = badge_aria(rust_svg)
            if label == "badge status":
                report.check(label, node_aria == rust_aria, f"node={node_aria!r} rust={rust_aria!r}")
            else:
                node_label = node_aria.split(":")[0] if node_aria else None
                rust_label = rust_aria.split(":")[0] if rust_aria else None
                report.check(f"{label} label", node_label == rust_label,
                             f"node={node_label!r} rust={rust_label!r}")
                if "uptime" in label:
                    report.check(f"{label} value",
                                 num_close(badge_message_number(node_aria),
                                           badge_message_number(rust_aria), 1.0),
                                 f"node={node_aria!r} rust={rust_aria!r}")

        print("== push contract ==")
        # Both sides accept an explicit pushToken; the Node API does not
        # mint one automatically (the Rust does), so pin it for the test.
        push_token_value = "parity-push-token"
        create_body = {
            "name": "parity-push",
            "type": "push",
            "interval": 180,
            "pushToken": push_token_value,
        }
        node_status, node_created, _ = node.request("POST", "/api/v1/monitors", create_body)
        rust_status, rust_created, _ = rust.request("POST", "/api/v1/monitors", create_body)
        report.check("create status 201", node_status == 201 and rust_status == 201,
                     f"node={node_status} rust={rust_status}")
        report.check("create ignoredFields",
                     node_created["ignoredFields"] == rust_created["ignoredFields"])

        rust_db = os.path.join(rust_data, "flatline.db")
        node_id = sqlite_scalar(node_db, "SELECT id FROM monitor WHERE name = 'parity-push'")
        rust_id = sqlite_scalar(rust_db, "SELECT id FROM monitors WHERE name = 'parity-push'")
        node_token = push_token_value
        rust_token = push_token_value

        def last_beat(db, table, monitor_id):
            conn = sqlite3.connect(db)
            try:
                return conn.execute(
                    f"SELECT status, ping, msg, important, retries FROM {table} "
                    "WHERE monitor_id = ? ORDER BY id DESC LIMIT 1",
                    (monitor_id,),
                ).fetchone()
            finally:
                conn.close()

        def beat_count(db, table, monitor_id):
            conn = sqlite3.connect(db)
            try:
                return conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE monitor_id = ?", (monitor_id,)
                ).fetchone()[0]
            finally:
                conn.close()

        node_status, node_body, _ = node.request("GET", f"/api/push/{node_token}")
        rust_status, rust_body, _ = rust.request("GET", f"/api/push/{rust_token}")
        report.check("push legacy ok", node_status == 200 and rust_status == 200
                     and node_body == rust_body, f"node={node_body} rust={rust_body}")
        report.check("push legacy beat",
                     last_beat(node_db, "heartbeat", node_id) == last_beat(rust_db, "heartbeats", rust_id),
                     f"node={last_beat(node_db, 'heartbeat', node_id)} rust={last_beat(rust_db, 'heartbeats', rust_id)}")

        node_before = beat_count(node_db, "heartbeat", node_id)
        rust_before = beat_count(rust_db, "heartbeats", rust_id)
        node_status, node_body, _ = node.request(
            "POST", f"/api/push/{node_token}?telemetry=1",
            {"metrics": {"cpu": {"percent": 10.0}}})
        rust_status, rust_body, _ = rust.request(
            "POST", f"/api/push/{rust_token}?telemetry=1",
            {"metrics": {"cpu": {"percent": 10.0}}})
        report.check("push telemetry ok", node_status == 200 and rust_status == 200
                     and node_body == rust_body, f"node={node_body} rust={rust_body}")
        report.check("push telemetry fast path",
                     beat_count(node_db, "heartbeat", node_id) == node_before
                     and beat_count(rust_db, "heartbeats", rust_id) == rust_before)

        node_status, _, _ = node.request("GET", f"/api/push/{node_token}?msg=parity&ping=12.5")
        rust_status, _, _ = rust.request("GET", f"/api/push/{rust_token}?msg=parity&ping=12.5")
        report.check("push legacy with msg", node_status == 200 and rust_status == 200)
        report.check("push beat fields",
                     last_beat(node_db, "heartbeat", node_id) == last_beat(rust_db, "heartbeats", rust_id))

        node_status, _, _ = node.request("GET", f"/api/push/{node_token}?status=down")
        rust_status, _, _ = rust.request("GET", f"/api/push/{rust_token}?status=down")
        report.check("push explicit down", node_status == 200 and rust_status == 200
                     and last_beat(node_db, "heartbeat", node_id) == last_beat(rust_db, "heartbeats", rust_id),
                     f"node={last_beat(node_db, 'heartbeat', node_id)} rust={last_beat(rust_db, 'heartbeats', rust_id)}")

        node_status, node_body, _ = node.request("GET", "/api/push/does-not-exist")
        rust_status, rust_body, _ = rust.request("GET", "/api/push/does-not-exist")
        report.check("push unknown 404", node_status == 404 and rust_status == 404
                     and node_body.get("msg") == rust_body.get("msg"),
                     f"node={node_body} rust={rust_body}")

        big = {"metrics": {"blob": "x" * 70000}}
        node_before = beat_count(node_db, "heartbeat", node_id)
        rust_before = beat_count(rust_db, "heartbeats", rust_id)
        node_status, node_body, _ = node.request("POST", f"/api/push/{node_token}", big)
        rust_status, rust_body, _ = rust.request("POST", f"/api/push/{rust_token}", big)
        report.check("push oversized 400", node_status == 400 and rust_status == 400,
                     f"node={node_status} rust={rust_status}")
        report.check("push oversized message",
                     str(node_body.get("msg", "")).startswith("Heartbeat recorded, metrics dropped")
                     and str(rust_body.get("msg", "")).startswith("Heartbeat recorded, metrics dropped"),
                     f"node={node_body.get('msg')} rust={rust_body.get('msg')}")
        report.check("push oversized heartbeat kept",
                     beat_count(node_db, "heartbeat", node_id) == node_before + 1
                     and beat_count(rust_db, "heartbeats", rust_id) == rust_before + 1)

        print("== api keys ==")
        _, node_keys, _ = node.request("GET", "/api/v1/api-keys")
        _, rust_keys, _ = rust.request("GET", "/api/v1/api-keys")
        node_fields = set(node_keys["apiKeys"][0].keys()) if node_keys["count"] else set()
        rust_fields = set(rust_keys["apiKeys"][0].keys()) if rust_keys["count"] else set()
        report.check("api-keys fields", node_fields <= rust_fields,
                     f"missing: {sorted(node_fields - rust_fields)}")

        node_status, node_created, _ = node.request("POST", "/api/v1/api-keys", {"name": "parity-key"})
        rust_status, rust_created, _ = rust.request("POST", "/api/v1/api-keys", {"name": "parity-key"})
        report.check("api-key create 201", node_status == 201 and rust_status == 201,
                     f"node={node_status} rust={rust_status}")
        node_key_token = node_created.get("token")
        rust_key_token = rust_created.get("token")
        report.check("minted key works",
                     node.request("GET", "/api/v1/health", token=node_key_token)[0] == 200
                     and rust.request("GET", "/api/v1/health", token=rust_key_token)[0] == 200)
        node_key_id = node_created["apiKey"]["id"]
        rust_key_id = rust_created["apiKey"]["id"]
        report.check("api-key delete",
                     node.request("DELETE", f"/api/v1/api-keys/{node_key_id}")[0] == 200
                     and rust.request("DELETE", f"/api/v1/api-keys/{rust_key_id}")[0] == 200)

        print()
        total = report.passes + len(report.failures)
        print(f"contract comparison: {report.passes}/{total} checks passed")
        if report.failures:
            print("failed checks:")
            for failure in report.failures:
                print(f"  - {failure}")
            return 1
        return 0
    finally:
        for process in (node_process, rust_process):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
        node_log.close()
        rust_log.close()
        if not args.keep:
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            print(f"workdir kept at {workdir}")


if __name__ == "__main__":
    sys.exit(main())
