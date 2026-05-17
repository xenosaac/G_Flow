import { describe, test, expect } from "bun:test";
import { renderPage, slugifySegment } from "../src/gbrain/page.ts";
import { buildPlanCreated, buildFeatureClose } from "../src/gbrain/snapshot.ts";

const TINY_CONTRACT = {
  flow_id: "f_test",
  goal: "test",
  created_at: "2026-05-16T00:00:00Z",
  milestones: [
    {
      id: "M-001",
      title: "M",
      endpoint_criteria: "ok",
      features: [
        {
          id: "F-001",
          title: "Add a todo button",
          spec: "spec",
          assertions: [
            {
              id: "A-001-001",
              text: "a",
              validator: "screwdriver" as const,
              evidence_required: "n/a",
              status: "pending" as const,
              origin: "original" as const,
              attempts: [],
              check: { kind: "file_exists" as const, path: "index.html" },
            },
          ],
        },
      ],
    },
  ],
};

describe("slugifySegment", () => {
  test("underscores → hyphens; double hyphens collapsed; trimmed", () => {
    expect(slugifySegment("F_2026_05_16__feature_close")).toBe(
      "f-2026-05-16-feature-close",
    );
  });

  test("non-ASCII → hyphens", () => {
    const out = slugifySegment("Tổng quan");
    expect(out).toMatch(/^[a-z0-9-]+$/);
  });

  test("empty input → 'x'", () => {
    expect(slugifySegment("")).toBe("x");
    expect(slugifySegment("___")).toBe("x");
  });

  test("kebab grammar invariant", () => {
    for (const input of [
      "F-001",
      "f_2026_05_16_5337",
      "plan_created",
      "Hello World!",
      "ABC___DEF",
    ]) {
      const slug = slugifySegment(input);
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("renderPage", () => {
  test("frontmatter uses type: note (NOT gflow-snapshot)", () => {
    const snap = buildPlanCreated({
      flow_id: "f_2026_05_16_1234",
      source_id: "gflow",
      goal: "build a static todo app",
      contract: TINY_CONTRACT,
    });
    const { content } = renderPage(snap);
    expect(content).toContain("type: note");
    expect(content).not.toContain("type: gflow-snapshot");
  });

  test("slug grammar: every segment kebab-case, no underscores", () => {
    const snap = buildFeatureClose({
      flow_id: "f_2026_05_16_1234",
      source_id: "gflow",
      contract: TINY_CONTRACT,
      feature_id: "F-001",
      milestone_id: "M-001",
      feature_title: "Add Todo Button",
    });
    const { slug } = renderPage(snap);
    expect(slug.startsWith("gflow/")).toBe(true);
    for (const seg of slug.split("/")) {
      expect(seg).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(seg).not.toContain("_");
    }
  });

  test("gflow: namespace carries original ids verbatim", () => {
    const snap = buildFeatureClose({
      flow_id: "f_2026_05_16_1234",
      source_id: "gflow",
      contract: TINY_CONTRACT,
      feature_id: "F-001",
      milestone_id: "M-001",
      feature_title: "Add Todo Button",
    });
    const { content } = renderPage(snap);
    expect(content).toContain("flow_id: f_2026_05_16_1234");
    expect(content).toContain("feature_id: F-001");
    expect(content).toContain("milestone_id: M-001");
    expect(content).toContain('kind: feature_close');
  });

  test("no timeline section in V2", () => {
    const snap = buildPlanCreated({
      flow_id: "f_test",
      source_id: "gflow",
      goal: "g",
      contract: TINY_CONTRACT,
    });
    const { content } = renderPage(snap);
    expect(content).not.toContain("<!-- timeline -->");
    // Body has Summary + Payload sections only.
    expect(content).toContain("## Summary");
    expect(content).toContain("## Payload");
  });

  test("tags include gflow + kebab versions of ids", () => {
    const snap = buildFeatureClose({
      flow_id: "f_2026_05_16_1234",
      source_id: "gflow",
      contract: TINY_CONTRACT,
      feature_id: "F-001",
      milestone_id: "M-001",
    });
    const { content } = renderPage(snap);
    const tagsLine = content.match(/tags: \[([^\]]+)\]/)![1]!;
    expect(tagsLine).toContain("gflow");
    expect(tagsLine).toContain("feature-close");
    expect(tagsLine).toContain("f-2026-05-16-1234");
    expect(tagsLine).toContain("f-001");
    expect(tagsLine).toContain("m-001");
  });
});
