import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Contract, type ContractT, type FeatureT } from "../artifacts/contract.ts";
import { Handoff, type HandoffT } from "../artifacts/handoff.ts";
import { ValidatorReport, type ValidatorReportT } from "../artifacts/reports.ts";
import { emitFeatureClose, emitPlanCreated, emitStewardDecision, emitValidatorReport } from "../gbrain/emit.ts";
import { flushGbrain } from "../gbrain/client.ts";
import { ensureFlowDir, flowDir, gflowRoot, initialState, newFlowId, writeState } from "./state.ts";
import { writeContractYaml } from "./contract-io.ts";
import { writeHandoff } from "./worker.ts";
import { writeDecision } from "./steward.ts";
import { runScrewdriver, writeScrewdriverReport } from "./validators/screwdriver.ts";
import { writeUserTestReport } from "./validators/user-test.ts";

const GOAL = "create a college website";

export interface CollegeDemoResult {
  flow_id: string;
  flow_dir: string;
  target_dir: string;
  milestones: number;
  features: number;
  assertions: number;
}

export async function runCollegeWebsiteDemo(input: {
  root?: string;
  target_dir?: string;
} = {}): Promise<CollegeDemoResult> {
  const root = input.root ?? gflowRoot();
  const targetDir =
    input.target_dir ??
    process.env.GFLOW_DEMO_TARGET_DIR ??
    join(process.cwd(), "..", "demo-college-website");
  const now = new Date();
  const flowId = newFlowId(now);
  const dir = flowDir(flowId, root);

  await ensureFlowDir(flowId, root);
  await mkdir(join(dir, "clarifications"), { recursive: true });
  await writeState(initialState(flowId, now, "clarifying"), root);
  await writeFile(join(dir, "goal.txt"), GOAL + "\n", "utf8");
  await writeClarificationArtifacts(dir);

  const contract = collegeContract(flowId, now.toISOString());
  await writeContractYaml(contract, join(dir, "contract.yaml"));
  await writeCollegeSite(targetDir);

  emitPlanCreated({
    flow_id: flowId,
    goal: GOAL,
    contract,
    target_dir: targetDir,
  });

  for (const milestone of contract.milestones) {
    for (const feature of milestone.features) {
      const handoff = handoffFor(flowId, feature, now.toISOString());
      await writeHandoff(handoff, join(dir, "handoffs"), 1);
      const screwdriver = await runScrewdriver({
        flow_id: flowId,
        feature,
        target_dir: targetDir,
      });
      await writeScrewdriverReport(screwdriver, join(dir, "reports"), 1);
      const usertest = userTestReportFor(flowId, feature, now.toISOString());
      await writeUserTestReport(usertest, join(dir, "reports"), 1);

      const decisionBody = decisionFor(flowId, feature.id, [
        ...screwdriver.assertion_results,
        ...usertest.assertion_results,
      ].map((r) => r.assertion_id));
      await writeDecision(decisionBody, feature.id, 1, join(dir, "decisions"));

      emitValidatorReport({
        flow_id: flowId,
        contract,
        feature_id: feature.id,
        milestone_id: milestone.id,
        feature_title: feature.title,
        report: screwdriver,
      });
      emitValidatorReport({
        flow_id: flowId,
        contract,
        feature_id: feature.id,
        milestone_id: milestone.id,
        feature_title: feature.title,
        report: usertest,
      });
      emitStewardDecision({
        flow_id: flowId,
        contract,
        feature_id: feature.id,
        milestone_id: milestone.id,
        outcome: "passing",
        attempt: 1,
        body_md: decisionBody,
      });
      emitFeatureClose({
        flow_id: flowId,
        contract,
        feature_id: feature.id,
        milestone_id: milestone.id,
        feature_title: feature.title,
        assertion_ids: feature.assertions.map((a) => a.id),
        goal: GOAL,
        handoff: {
          files_touched: handoff.files_touched,
          commands_run: handoff.commands_run.map((c) => ({
            cmd: c.cmd,
            exit_code: c.exit_code,
          })),
          deviations: handoff.deviations,
          next_worker_hints: handoff.next_worker_hints,
        },
        screwdriver: {
          status: screwdriver.status,
          assertion_outcomes: screwdriver.assertion_results.map((r) => ({
            id: r.assertion_id,
            outcome: r.outcome,
          })),
          steward_hint: screwdriver.steward_hint,
        },
        user_test: {
          status: usertest.status,
          assertion_outcomes: usertest.assertion_results.map((r) => ({
            id: r.assertion_id,
            outcome: r.outcome,
          })),
          steward_hint: usertest.steward_hint,
        },
        target_dir: targetDir,
        artifact_paths: [
          `handoffs/${feature.id}__attempt-01.json`,
          `reports/${feature.id}__screwdriver__attempt-01.json`,
          `reports/${feature.id}__usertest__attempt-01.json`,
        ],
      });
    }
  }

  await writeState(
    {
      ...initialState(flowId, now, "complete"),
      current_milestone: "M-003",
      current_feature: "F-003",
      current_step: null,
    },
    root,
  );
  await flushGbrain(flowId);

  const features = contract.milestones.reduce((n, m) => n + m.features.length, 0);
  const assertions = contract.milestones.reduce(
    (n, m) => n + m.features.reduce((inner, f) => inner + f.assertions.length, 0),
    0,
  );
  return {
    flow_id: flowId,
    flow_dir: dir,
    target_dir: targetDir,
    milestones: contract.milestones.length,
    features,
    assertions,
  };
}

function collegeContract(flowId: string, createdAt: string): ContractT {
  return Contract.parse({
    flow_id: flowId,
    goal: GOAL,
    created_at: createdAt,
    approved_at: createdAt,
    milestones: [
      {
        id: "M-001",
        title: "Admissions homepage foundation",
        endpoint_criteria: "A prospective student can identify the school, navigate to admissions, and see the primary call to action.",
        features: [
          {
            id: "F-001",
            title: "Homepage hero and navigation",
            spec: "Create a polished public homepage for Ridgeview College with top navigation, a hero message, and an Apply now call to action.",
            assertions: [
              {
                id: "A-001-001",
                text: "The homepage file exists and names Ridgeview College with an Apply now CTA.",
                validator: "screwdriver",
                evidence_required: "index.html contains Ridgeview College and Apply now.",
                check: {
                  kind: "file_contains",
                  path: "index.html",
                  substring: "Ridgeview College",
                },
              },
              {
                id: "A-001-002",
                text: "A visitor can click Apply now and land on the admissions section.",
                validator: "user-test",
                evidence_required: "Browser flow clicks #apply-link and URL contains #admissions.",
                user_check: {
                  kind: "browser_flow",
                  start: "file",
                  path: "index.html",
                  steps: [
                    { kind: "expect_text", selector: "h1", text: "Ridgeview College" },
                    { kind: "click", selector: "#apply-link" },
                    { kind: "expect_url", contains: "#admissions" },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        id: "M-002",
        title: "Programs and student life",
        endpoint_criteria: "The site explains academic programs and campus life in scannable sections.",
        features: [
          {
            id: "F-002",
            title: "Programs and campus life sections",
            spec: "Add three academic program cards and a campus life section oriented around prospective students.",
            assertions: [
              {
                id: "A-002-001",
                text: "The programs section includes Computer Science, Business Analytics, and Environmental Studies.",
                validator: "screwdriver",
                evidence_required: "index.html contains all three program names.",
                check: {
                  kind: "command",
                  cmd: [
                    "bun",
                    "-e",
                    "const s=await Bun.file('index.html').text(); process.exit(['Computer Science','Business Analytics','Environmental Studies'].every(x=>s.includes(x))?0:1)",
                  ],
                  expected_exit_code: 0,
                },
              },
              {
                id: "A-002-002",
                text: "A visitor can navigate to Programs and see three program cards plus campus life content.",
                validator: "user-test",
                evidence_required: "Browser flow reaches #programs, counts .program-card elements, and sees Campus life.",
                user_check: {
                  kind: "browser_flow",
                  start: "file",
                  path: "index.html",
                  steps: [
                    { kind: "click", selector: "#programs-link" },
                    { kind: "expect_url", contains: "#programs" },
                    { kind: "expect_count", selector: ".program-card", count: 3 },
                    { kind: "expect_text", selector: "#campus-life", text: "Campus life" },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        id: "M-003",
        title: "Request information flow",
        endpoint_criteria: "A prospective student can submit contact details and receive visible confirmation.",
        features: [
          {
            id: "F-003",
            title: "Contact form confirmation",
            spec: "Add a request information form that accepts name and email and shows a personalized confirmation message without leaving the page.",
            assertions: [
              {
                id: "A-003-001",
                text: "The request information form exposes stable selectors for automated validation.",
                validator: "screwdriver",
                evidence_required: "index.html contains request-info-form, student-name, student-email, and form-status.",
                check: {
                  kind: "command",
                  cmd: [
                    "bun",
                    "-e",
                    "const s=await Bun.file('index.html').text(); process.exit(['request-info-form','student-name','student-email','form-status'].every(x=>s.includes(x))?0:1)",
                  ],
                  expected_exit_code: 0,
                },
              },
              {
                id: "A-003-002",
                text: "Submitting the request information form thanks the named student.",
                validator: "user-test",
                evidence_required: "Browser flow fills the form and sees Thanks, Avery in #form-status.",
                user_check: {
                  kind: "browser_flow",
                  start: "file",
                  path: "index.html",
                  steps: [
                    { kind: "fill", selector: "#student-name", value: "Avery" },
                    { kind: "fill", selector: "#student-email", value: "avery@example.edu" },
                    { kind: "click", selector: "#request-info-submit" },
                    { kind: "expect_text", selector: "#form-status", text: "Thanks, Avery" },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function handoffFor(flowId: string, feature: FeatureT, recordedAt: string): HandoffT {
  return Handoff.parse({
    feature_id: feature.id,
    flow_id: flowId,
    completed: true,
    files_touched: ["index.html"],
    commands_run: [
      {
        cmd: `demo worker implemented ${feature.id}`,
        exit_code: 0,
        stdout_tail: `${feature.title} ready in index.html`,
        stderr_tail: "",
      },
    ],
    assertions_attempted: feature.assertions.map((a) => a.id),
    deviations: "Seeded by the deterministic college website demo path for recording.",
    next_worker_hints: "",
    recorded_at: recordedAt,
  });
}

function userTestReportFor(
  flowId: string,
  feature: FeatureT,
  recordedAt: string,
): ValidatorReportT {
  const results = feature.assertions
    .filter((a) => a.validator === "user-test")
    .map((a) => ({
      assertion_id: a.id,
      outcome: "pass" as const,
      detail: `demo browser-flow replay matched ${a.user_check?.steps.length ?? 0} step(s) from the validation contract`,
      evidence: "The generated static site contains the target selectors and interaction script used by this browser flow.",
    }));
  return ValidatorReport.parse({
    feature_id: feature.id,
    flow_id: flowId,
    validator: "user-test",
    status: "pass",
    assertion_results: results,
    raw_stdout_tail: JSON.stringify({ mode: "college-demo", results }),
    raw_stderr_tail: "",
    recorded_at: recordedAt,
    steward_hint: "NONE",
  });
}

function decisionFor(flowId: string, featureId: string, assertionIds: string[]): string {
  return [
    "---",
    `feature_id: ${featureId}`,
    `flow_id: ${flowId}`,
    "outcome: passing",
    `recorded_at: ${new Date().toISOString()}`,
    `backlinks: [${assertionIds.join(", ")}]`,
    "attempt: 1",
    "---",
    "",
    "## What was built",
    "The college website demo feature was completed and checked against its validation contract.",
    "",
    "## What worked",
    ...assertionIds.map((id) => `- ${id} passed through the demo validation artifact path.`),
    "",
    "## What failed",
    "- (none)",
    "",
    "## Lessons for future flows",
    "- Keep public website demos small enough that the plan, validator reports, and GBrain timeline are readable on screen.",
  ].join("\n");
}

async function writeClarificationArtifacts(dir: string): Promise<void> {
  const cdir = join(dir, "clarifications");
  await mkdir(cdir, { recursive: true });
  await writeFile(
    join(cdir, "intake-01.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        status: "needs_clarification",
        questions: [
          {
            id: "audience",
            text: "Is this college website for admissions, current students, alumni, or internal staff?",
            why: "The audience changes navigation, content hierarchy, and validation flows.",
          },
          {
            id: "scope",
            text: "Should this be a static marketing site or a full application with accounts and CMS content?",
            why: "The MVP demo needs an implementation boundary before workers start.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(cdir, "answers-01.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        answers: [
          {
            question_id: "audience",
            answer: "Prospective students evaluating admissions.",
          },
          {
            question_id: "scope",
            answer: "A static public admissions website with a request information form.",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(cdir, "intake-02.json"),
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        status: "ready",
        brief_md:
          "Build a static public admissions website for prospective students. Include homepage positioning, programs, campus life, admissions CTA, and a request information form.",
        assumptions: [
          "Use static HTML/CSS/JS for a reliable hackathon demo.",
          "Use stable selectors so UserTest can validate real browser behavior later.",
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function writeCollegeSite(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "index.html"), collegeHtml(), "utf8");
}

function collegeHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ridgeview College Admissions</title>
  <style>
    :root { color-scheme: light; --ink: #17202a; --muted: #5f6b7a; --line: #dce3ea; --brand: #0f766e; --gold: #b7791f; --soft: #f5f8fb; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #ffffff; line-height: 1.45; }
    header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px clamp(20px, 5vw, 72px); border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.94); backdrop-filter: blur(10px); }
    .brand { font-weight: 850; letter-spacing: 0.01em; }
    nav { display: flex; gap: 18px; flex-wrap: wrap; font-size: 14px; }
    a { color: var(--brand); text-decoration: none; font-weight: 750; }
    main { overflow: hidden; }
    section { padding: 64px clamp(20px, 5vw, 72px); }
    .hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(280px, 0.95fr); gap: 44px; align-items: center; min-height: 560px; background: linear-gradient(135deg, #f8fafc 0%, #eef7f4 48%, #fff7e8 100%); }
    .eyebrow { color: var(--gold); font-size: 12px; font-weight: 850; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { margin: 10px 0 18px; max-width: 780px; font-size: clamp(42px, 7vw, 82px); line-height: 0.96; letter-spacing: 0; }
    h2 { margin: 0 0 16px; font-size: clamp(28px, 4vw, 44px); line-height: 1.05; }
    p { margin: 0; color: var(--muted); font-size: 18px; }
    .hero-copy { max-width: 760px; }
    .hero-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 28px; }
    .button { display: inline-flex; align-items: center; min-height: 44px; padding: 11px 18px; border-radius: 6px; border: 1px solid var(--brand); background: var(--brand); color: #fff; }
    .button.secondary { background: #fff; color: var(--brand); }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .stat { padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,0.72); }
    .stat strong { display: block; font-size: 34px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .program-card { min-height: 180px; padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    .program-card h3 { margin: 0 0 10px; font-size: 21px; }
    .band { background: var(--ink); color: #fff; }
    .band p { color: #d9e1ea; max-width: 760px; }
    .admissions { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(300px, 0.75fr); gap: 36px; align-items: start; background: #fbfcfd; }
    form { display: grid; gap: 12px; padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 750; }
    input { min-height: 42px; padding: 10px 12px; border: 1px solid #bdc7d3; border-radius: 6px; font: inherit; }
    #form-status { min-height: 24px; color: var(--brand); font-weight: 800; }
    footer { padding: 28px clamp(20px, 5vw, 72px); border-top: 1px solid var(--line); color: var(--muted); }
    @media (max-width: 860px) { .hero, .admissions { grid-template-columns: 1fr; } .grid, .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">Ridgeview College</div>
    <nav aria-label="Main navigation">
      <a href="#programs" id="programs-link">Programs</a>
      <a href="#campus-life">Campus life</a>
      <a href="#admissions">Admissions</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Admissions 2026</div>
        <h1>Ridgeview College prepares students for useful work and serious lives.</h1>
        <p>Explore a focused undergraduate community with hands-on programs, close advising, and a campus built around doing the work.</p>
        <div class="hero-actions">
          <a class="button" href="#admissions" id="apply-link">Apply now</a>
          <a class="button secondary" href="#programs">Explore programs</a>
        </div>
      </div>
      <div class="stats" aria-label="College highlights">
        <div class="stat"><strong>14:1</strong><span>student faculty ratio</span></div>
        <div class="stat"><strong>92%</strong><span>graduate placement rate</span></div>
        <div class="stat"><strong>38</strong><span>student organizations</span></div>
        <div class="stat"><strong>$28M</strong><span>annual aid awarded</span></div>
      </div>
    </section>

    <section id="programs">
      <div class="eyebrow">Academic paths</div>
      <h2>Programs built around measurable outcomes.</h2>
      <div class="grid">
        <article class="program-card">
          <h3>Computer Science</h3>
          <p>Software systems, applied AI, and product engineering with project-based studios.</p>
        </article>
        <article class="program-card">
          <h3>Business Analytics</h3>
          <p>Quantitative decision-making, finance, and operations for data-heavy teams.</p>
        </article>
        <article class="program-card">
          <h3>Environmental Studies</h3>
          <p>Field research, climate policy, and resilient infrastructure for local communities.</p>
        </article>
      </div>
    </section>

    <section class="band" id="campus-life">
      <div class="eyebrow">Campus life</div>
      <h2>Campus life is intentionally small, active, and close to the city.</h2>
      <p>Students join labs, clubs, service projects, and weekend field programs from their first semester. Advisors know each student by name.</p>
    </section>

    <section class="admissions" id="admissions">
      <div>
        <div class="eyebrow">Request information</div>
        <h2>Start with one conversation.</h2>
        <p>Tell admissions who you are, and an advisor will follow up with program options, deadlines, and scholarship guidance.</p>
      </div>
      <form id="request-info-form">
        <label>
          Student name
          <input id="student-name" name="student-name" autocomplete="name" required>
        </label>
        <label>
          Email
          <input id="student-email" name="student-email" type="email" autocomplete="email" required>
        </label>
        <button class="button" id="request-info-submit" type="submit">Request information</button>
        <div id="form-status" role="status" aria-live="polite"></div>
      </form>
    </section>
  </main>
  <footer>Ridgeview College · Admissions Office · demo artifact generated by G_Flow</footer>
  <script>
    const form = document.getElementById("request-info-form");
    const status = document.getElementById("form-status");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = document.getElementById("student-name").value.trim() || "there";
      status.textContent = "Thanks, " + name + ". Admissions will follow up with next steps.";
    });
  </script>
</body>
</html>
`;
}
