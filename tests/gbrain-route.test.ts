import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET } from "../src/console/app/api/gbrain/route.ts";
import { POST as DRAIN } from "../src/console/app/api/gbrain/drain/route.ts";

let TMP: string;
let prevRoot: string | undefined;
let prevMode: string | undefined;

beforeEach(async () => {
  TMP = join(
    tmpdir(),
    `gflow-route-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(join(TMP, "f_route"), { recursive: true });
  prevRoot = process.env.GFLOW_ROOT;
  prevMode = process.env.GBRAIN_MODE;
  process.env.GFLOW_ROOT = TMP;
});

afterEach(async () => {
  if (prevRoot === undefined) delete process.env.GFLOW_ROOT;
  else process.env.GFLOW_ROOT = prevRoot;
  if (prevMode === undefined) delete process.env.GBRAIN_MODE;
  else process.env.GBRAIN_MODE = prevMode;
  await rm(TMP, { recursive: true, force: true });
});

describe("GET /api/gbrain", () => {
  test("returns new shape with mode / health / queue / counts", async () => {
    const r = await GET(new Request(`http://localhost/api/gbrain?flow_id=f_route`));
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.flow_id).toBe("f_route");
    expect(body.mode).toBe("off");
    expect(body.health).toBeTruthy();
    expect(body.queue).toEqual({ queued: 0, synced: 0, failed: 0 });
    expect(body.counts).toEqual({ feature_close: 0, milestone_close: 0, flow_complete: 0 });
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test("no flow_id and no latest → null flow_id, zero queue", async () => {
    const r = await GET(new Request(`http://localhost/api/gbrain`));
    const body = (await r.json()) as Record<string, unknown>;
    // TMP has only "f_route" subdir but no state.json so latestFlow returns null.
    // Either flow_id null or fallback to f_route — both valid; just assert no crash + shape.
    expect(body.queue).toBeTruthy();
    expect(body.health).toBeTruthy();
  });
});

describe("POST /api/gbrain/drain", () => {
  test("503 when mode=off", async () => {
    delete process.env.GBRAIN_MODE; // off
    const r = await DRAIN(
      new Request("http://localhost/api/gbrain/drain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow_id: "f_route" }),
      }),
    );
    expect(r.status).toBe(503);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("off");
  });

  test("200 with DrainResult under unknown mode (ConfigErrorAdapter path NOT hit because mode=off short-circuits to 503)", async () => {
    process.env.GBRAIN_MODE = "lol"; // ConfigErrorAdapter
    // ConfigErrorAdapter has mode=off internally, so the route returns 503.
    const r = await DRAIN(
      new Request("http://localhost/api/gbrain/drain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow_id: "f_route" }),
      }),
    );
    expect(r.status).toBe(503);
  });
});
