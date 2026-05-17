import { describe, test, expect } from "bun:test";
import { parseCommand, HELP_TEXT } from "../src/console/lib/commands.ts";

describe("parseCommand", () => {
  test("empty / whitespace → null", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("   ")).toBeNull();
    expect(parseCommand("\n\t  \n")).toBeNull();
  });

  test("plain text → chat", () => {
    expect(parseCommand("hello world")).toEqual({ kind: "chat", text: "hello world" });
  });

  test("multi-line plain text → chat (trimmed)", () => {
    expect(parseCommand("  build a thing\nwith two lines  ")).toEqual({
      kind: "chat",
      text: "build a thing\nwith two lines",
    });
  });

  test("/start <goal> → start", () => {
    expect(parseCommand("/start build a todo app")).toEqual({
      kind: "start",
      goal: "build a todo app",
    });
  });

  test("/start with leading whitespace + multi-word arg", () => {
    expect(parseCommand("  /start  a very long goal description  ")).toEqual({
      kind: "start",
      goal: "a very long goal description",
    });
  });

  test("/start without goal → unknown", () => {
    expect(parseCommand("/start")).toEqual({
      kind: "unknown",
      name: "start (missing <goal>)",
    });
    expect(parseCommand("/start   ")).toEqual({
      kind: "unknown",
      name: "start (missing <goal>)",
    });
  });

  test("/resume + /approve → resume", () => {
    expect(parseCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseCommand("/approve")).toEqual({ kind: "resume" });
    expect(parseCommand("/Resume")).toEqual({ kind: "resume" }); // case-insensitive
  });

  test("/pause → pause", () => {
    expect(parseCommand("/pause")).toEqual({ kind: "pause" });
  });

  test("/status → status", () => {
    expect(parseCommand("/status")).toEqual({ kind: "status" });
  });

  test("/help and /? → help", () => {
    expect(parseCommand("/help")).toEqual({ kind: "help" });
    expect(parseCommand("/?")).toEqual({ kind: "help" });
  });

  test("unknown slash → unknown with name", () => {
    expect(parseCommand("/bogus")).toEqual({ kind: "unknown", name: "bogus" });
    expect(parseCommand("/foo bar baz")).toEqual({ kind: "unknown", name: "foo" });
  });

  test("commands are case-insensitive", () => {
    expect(parseCommand("/START build a thing")).toEqual({
      kind: "start",
      goal: "build a thing",
    });
    expect(parseCommand("/STATUS")).toEqual({ kind: "status" });
  });

  test("multi-line /start preserves arg formatting after first whitespace", () => {
    // Multi-line goals are valid — useful for paste-in long prompts.
    expect(parseCommand("/start build a todo app\nthat persists to localStorage")).toEqual({
      kind: "start",
      goal: "build a todo app\nthat persists to localStorage",
    });
  });

  test("a chat message that starts with / inside (not at start) is still chat", () => {
    expect(parseCommand("explain /start vs gflow start")).toEqual({
      kind: "chat",
      text: "explain /start vs gflow start",
    });
  });

  test("HELP_TEXT mentions every slash command", () => {
    for (const c of ["/start", "/pause", "/resume", "/approve", "/status", "/new", "/help"]) {
      expect(HELP_TEXT).toContain(c);
    }
  });

  test("/new and /clear → new", () => {
    expect(parseCommand("/new")).toEqual({ kind: "new" });
    expect(parseCommand("/clear")).toEqual({ kind: "new" });
    expect(parseCommand("/NEW")).toEqual({ kind: "new" });
  });
});
