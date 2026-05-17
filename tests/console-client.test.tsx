import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import ConsoleClient from "../src/console/components/ConsoleClient";
import type { FlowSnapshot } from "../src/console/lib/snapshot.ts";

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.closed = true;
  }
}

const FLOW_SNAPSHOT: FlowSnapshot = {
  flow_id: "f_2026_05_16_7321",
  goal: "Build a school official website",
  state: {
    flow_id: "f_2026_05_16_7321",
    phase: "executing",
    current_milestone: "M-001",
    current_feature: "F-001",
    current_step: "worker",
    corrective_attempts: {},
    counters: { llm_calls: 0, tokens_in: 0, tokens_out: 0, usd_spent: 0 },
    started_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
  },
  contract: {
    flow_id: "f_2026_05_16_7321",
    goal: "Build a school official website",
    created_at: "2026-05-16T00:00:00.000Z",
    milestones: [
      {
        id: "M-001",
        title: "Foundation and homepage",
        endpoint_criteria: "homepage exists",
        features: [
          {
            id: "F-001",
            title: "Project scaffold and entry HTML",
            spec: "Create the entry page.",
            assertions: [
              {
                id: "A-001",
                text: "index exists",
                validator: "screwdriver",
                evidence_required: "index.html exists",
                status: "pending",
                origin: "original",
                attempts: [],
              },
            ],
          },
        ],
      },
    ],
  },
  latest: {
    handoff: null,
    screwdriver: null,
    usertest: null,
    triage: null,
  },
  attempt_history: {
    "F-001": { attempts: 0, latest_failures: [] },
  },
  clarification_questions: [],
  needs_human_reason: null,
};

let root: Root | null = null;

beforeEach(() => {
  const window = new Window({ url: "http://localhost:3031" });
  window.SyntaxError = SyntaxError;
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  globalThis.Event = window.Event as unknown as typeof Event;
  globalThis.KeyboardEvent = window.KeyboardEvent as unknown as typeof KeyboardEvent;
  globalThis.MouseEvent = window.MouseEvent as unknown as typeof MouseEvent;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/backends")) {
      return Response.json({ backends: [{ name: "codex", available: true }] });
    }
    if (url.startsWith("/api/gbrain")) {
      return Response.json({
        flow_id: FLOW_SNAPSHOT.flow_id,
        entries: [],
        counts: { feature_close: 0, milestone_close: 0, flow_complete: 0 },
      });
    }
    if (url.startsWith("/api/demo/college-website")) {
      return Response.json({
        ok: true,
        flow_id: FLOW_SNAPSHOT.flow_id,
        target_dir: "/tmp/demo-college-website",
        milestones: 1,
        features: 1,
        assertions: 1,
        snapshot: FLOW_SNAPSHOT,
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("ConsoleClient", () => {
  test("+ New Chat clears the visible flow and ignores the dismissed SSE snapshot", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(<ConsoleClient initial={FLOW_SNAPSHOT} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Foundation and homepage");
    expect(document.body.textContent).toContain("Project scaffold and entry HTML");

    const button = document.querySelector(
      '[data-testid="workbench-new-chat"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
    });

    expect(document.body.textContent).toContain("No plan yet");
    expect(document.body.textContent).toContain("No snapshots queued for this flow yet.");
    expect(document.body.textContent).not.toContain("Foundation and homepage");

    const activeSource = MockEventSource.instances.at(-1)!;
    await act(async () => {
      activeSource.emit({ type: "snapshot", data: FLOW_SNAPSHOT });
    });

    expect(document.body.textContent).toContain("No plan yet");
    expect(document.body.textContent).not.toContain("Project scaffold and entry HTML");
  });

  test("College Demo button loads the returned flow snapshot", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(<ConsoleClient initial={null} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = document.querySelector(
      '[data-testid="workbench-college-demo"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("College website demo loaded");
    expect(document.body.textContent).toContain("Foundation and homepage");
    expect(document.body.textContent).toContain("Project scaffold and entry HTML");
  });
});
