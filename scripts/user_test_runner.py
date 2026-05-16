#!/usr/bin/env python3
"""
G_Flow UserTest runner — wraps `browser-use`.

Reads a JSON spec on stdin:
    {
      "target_url": "http://localhost:3000",
      "assertions": [
        {"id": "A-001-002", "text": "...", "evidence_required": "..."},
        ...
      ]
    }

Writes a JSON report to stdout:
    {
      "results": [
        {"assertion_id": "...", "outcome": "pass"|"fail", "detail": "...", "evidence": "..."},
        ...
      ]
    }

Exit code contract (this is the G2 surface the orchestrator depends on):
    0  -> JSON written; treat as validator result
    !=0 -> tool failure; orchestrator MUST classify as INFRA, NOT corrective

This file is a thin wrapper. The actual browser-use orchestration only runs if
the `browser_use` package can be imported. Otherwise we exit 3 with a clear
stderr message so G_Flow's UserTest validator surfaces a tool_error.
"""
from __future__ import annotations

import json
import os
import sys
import traceback


def fail(msg: str, code: int) -> None:
    sys.stderr.write(f"user_test_runner: {msg}\n")
    sys.exit(code)


def main() -> None:
    try:
        spec = json.load(sys.stdin)
    except Exception as e:
        fail(f"invalid input JSON: {e}", 2)
        return

    assertions = spec.get("assertions", [])
    target_url = spec.get("target_url", "")
    if not isinstance(assertions, list) or not isinstance(target_url, str):
        fail("spec must include `target_url` and `assertions` list", 2)
        return

    # G_FLOW_USERTEST_FAKE — escape hatch used by tests / dry-run demos.
    # When set, return a canned response without invoking browser-use.
    fake = os.environ.get("G_FLOW_USERTEST_FAKE", "")
    if fake:
        results = []
        for a in assertions:
            results.append(
                {
                    "assertion_id": a.get("id", "unknown"),
                    "outcome": fake.lower() if fake.lower() in ("pass", "fail") else "pass",
                    "detail": f"G_FLOW_USERTEST_FAKE={fake}",
                    "evidence": "",
                }
            )
        sys.stdout.write(json.dumps({"results": results}))
        sys.exit(0)

    try:
        from browser_use import Agent  # type: ignore  # noqa: F401
    except Exception as e:
        # G2: ImportError / version mismatch surfaces here.
        fail(f"browser-use not importable: {e}", 3)
        return

    # G2 second-half: browser-use is installed BUT no LLM API key is set.
    # browser-use needs a provider key to drive the model. With none of these
    # set, the agent would either crash at the first prompt or silently fail
    # the assertion — both surface as "code bug" to a corrective Worker. Exit
    # nonzero so the TS wrapper classifies as tool_error + INFRA instead.
    api_keys = [
        os.environ.get("BROWSER_USE_API_KEY"),
        os.environ.get("OPENAI_API_KEY"),
        os.environ.get("ANTHROPIC_API_KEY"),
        os.environ.get("GOOGLE_API_KEY"),
    ]
    if not any(k for k in api_keys):
        fail(
            "no LLM API key set for browser-use "
            "(need one of BROWSER_USE_API_KEY / OPENAI_API_KEY / "
            "ANTHROPIC_API_KEY / GOOGLE_API_KEY)",
            4,
        )
        return

    # Real run path. Per-assertion: drive browser-use to verify.
    # This is the minimum viable runner; calibrate prompts when integrating.
    try:
        from browser_use import Agent  # type: ignore
    except Exception as e:
        fail(f"browser-use import failed at runtime: {e}", 3)
        return

    results = []
    for a in assertions:
        aid = a.get("id", "unknown")
        text = a.get("text", "")
        try:
            # NOTE: real implementation should pass target_url + assertion text
            # to an Agent and inspect its run trace. For V1 we run a minimal
            # check and rely on browser-use's own success/failure signal.
            agent = Agent(  # type: ignore[call-arg]
                task=f"At {target_url}, verify this is true: {text}",
            )
            outcome_obj = agent.run_sync()  # type: ignore[attr-defined]
            success = bool(getattr(outcome_obj, "success", False))
            results.append(
                {
                    "assertion_id": aid,
                    "outcome": "pass" if success else "fail",
                    "detail": str(getattr(outcome_obj, "final_result", "")),
                    "evidence": str(getattr(outcome_obj, "trace_path", "")),
                }
            )
        except Exception as e:
            tb = "".join(traceback.format_exception_only(type(e), e)).strip()
            results.append(
                {
                    "assertion_id": aid,
                    "outcome": "fail",
                    "detail": f"browser-use raised: {tb}",
                    "evidence": "",
                }
            )

    sys.stdout.write(json.dumps({"results": results}))
    sys.exit(0)


if __name__ == "__main__":
    main()
