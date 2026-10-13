import test from "node:test";
import assert from "node:assert/strict";
import { watchLive } from "../src/lib/api.ts";
import { healthFromMonitors } from "../src/lib/live-state.ts";

test("stream uses bearer headers, buffers fragmented deltas until snapshot completes, and cancels", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.window = {localStorage:{getItem:()=>"test-bearer"}};
    globalThis.document = {hidden:false};
    let releaseSnapshot;
    const snapshotGate = new Promise(resolve => {releaseSnapshot=resolve;});
    const events=[];
    const errors=[];
    let stream;
    let aborted=false;
    globalThis.fetch = async (url, init) => {
        assert.equal(url, "/api/v1/events?metrics=0");
        assert.equal(init.headers.Authorization, "Bearer test-bearer");
        init.signal.addEventListener("abort", () => {aborted=true;stream.error(new Error("aborted"));});
        return new Response(new ReadableStream({start(c){stream=c;}}), {headers:{"Content-Type":"text/event-stream"}});
    };
    const stop=watchLive({metrics:false, snapshot:()=>snapshotGate, event:e=>events.push(e), error:e=>errors.push(e)});
    const encode=value=>new TextEncoder().encode(value);
    try {
        await new Promise(r=>setTimeout(r,0));
        stream.enqueue(encode('data: {"type":"ready"}\n\ndata: {"type":"heart'));
        stream.enqueue(encode('beat","monitorId":1,"patch":{"status":0}}\n\n'));
        await new Promise(r=>setTimeout(r,10));
        assert.equal(events.length,0);
        releaseSnapshot();
        await new Promise(r=>setTimeout(r,10));
        assert.equal(events.length,1);
        assert.equal(events[0].patch.status,0);
        stop();
        assert.equal(aborted,true);
        assert.equal(errors.length,0);
    } finally {stop();globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.document;}
});

test("health counters track live states, with paused monitors excluded from failures", () => {
    const monitors=[{id:1,name:"a",url:null,active:true,status:0},{id:2,active:false,status:0},{id:3,active:true,status:1}];
    const health=healthFromMonitors(monitors);
    assert.equal(health.down,1);
    assert.equal(health.paused,1);
    assert.equal(health.up,1);
    assert.equal(health.status,"down");
    assert.equal(healthFromMonitors(monitors.map(m=>({...m,status:1}))).status,"up");
});

test("unauthorized stream stops without snapshots, retries or token URLs", async () => {
    const originalFetch=globalThis.fetch;
    globalThis.window={localStorage:{getItem:()=>"revoked"}};
    globalThis.document={hidden:false};
    let snapshots=0, calls=0;
    let fail;
    const failed=new Promise(resolve=>{fail=resolve;});
    globalThis.fetch=async(url)=>{calls++;assert.equal(url,"/api/v1/events");return new Response("",{status:401});};
    const stop=watchLive({snapshot:async()=>{snapshots++;},event:()=>assert.fail("unexpected event"),error:fail});
    try {
        assert.equal((await failed).status,401);
        assert.equal(snapshots,0);
        assert.equal(calls,1);
    } finally {stop();globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.document;}
});

test("a hung snapshot cannot disable stream recovery", async () => {
    // The audit's reproduction: the stream dies (here: the watchdog aborts
    // it), the snapshot never resolves, and recovery used to stop dead —
    // no error callback, no reconnect, `connected` stuck true.
    const originalFetch = globalThis.fetch;
    globalThis.window = { localStorage: { getItem: () => "test" } };
    globalThis.document = { hidden: false };

    const errors = [];
    let streamAttempts = 0;
    let snapshotCalls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let snapshotSignal;

    globalThis.fetch = async (url, init) => {
        streamAttempts++;
        // Stay open and silent: the reader times out waiting for a frame and
        // the watchdog aborts. The abort listener is what a real socket does.
        init.signal.addEventListener("abort", () => {});
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'));
            },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };

    const stop = watchLive({
        watchdogMs: 40,
        snapshotTimeoutMs: 150,
        snapshot: (signal) => {
            snapshotCalls++;
            snapshotSignal = signal;
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            return new Promise(() => {
                // Never resolves on its own: only the deadline (or unmount)
                // may end it.
                signal?.addEventListener("abort", () => { concurrent--; });
            });
        },
        event: () => assert.fail("no deltas are delivered"),
        error: e => errors.push(e),
    });

    try {
        await new Promise(resolve => setTimeout(resolve, 1800));
        assert.ok(snapshotCalls >= 1, "the ready frame must trigger a snapshot");
        assert.ok(errors.length >= 1, "a dead stream must report an error");
        assert.ok(streamAttempts >= 2, `reconnect must not wait for the snapshot (attempts=${streamAttempts})`);
        assert.equal(snapshotSignal?.aborted, true, "the snapshot deadline must cancel its fetches");
        assert.equal(maxConcurrent, 1, "fallback and reconnect snapshots must never overlap");
    } finally {
        stop();
        globalThis.fetch = originalFetch;
        delete globalThis.window;
        delete globalThis.document;
    }
});

test("stream reconnect obtains a fresh snapshot before subsequent deltas", async () => {
    const originalFetch=globalThis.fetch;
    globalThis.window={localStorage:{getItem:()=>"test"}};
    globalThis.document={hidden:false};
    let calls=0, snapshots=0, received;
    const delivered=new Promise(resolve=>{received=resolve;});
    globalThis.fetch=async(_url,init)=>{
        calls++;
        const first=calls===1;
        return new Response(new ReadableStream({start(c){
            c.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'));
            if(first){c.close();}else{
                c.enqueue(new TextEncoder().encode('data: {"type":"heartbeat","monitorId":1,"patch":{"status":1}}\n\n'));
                init.signal.addEventListener("abort",()=>c.error(new Error("abort")));
            }
        }}),{headers:{"Content-Type":"text/event-stream"}});
    };
    const stop=watchLive({snapshot:async()=>{snapshots++;},event:e=>received(e),error:()=>{}});
    try {
        const event=await delivered;
        assert.equal(event.patch.status,1);
        assert.equal(calls,2);
        assert.ok(snapshots>=2);
    } finally {stop();globalThis.fetch=originalFetch;delete globalThis.window;delete globalThis.document;}
});
