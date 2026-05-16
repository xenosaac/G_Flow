import { describe, test, expect } from "bun:test";
import { main } from "../src/cli/index.ts";

describe("M1 bootstrap", () => {
  test("`gflow help` exits 0", async () => {
    const code = await main(["help"]);
    expect(code).toBe(0);
  });

  test("no args prints help and exits 0", async () => {
    const code = await main([]);
    expect(code).toBe(0);
  });

  test("`gflow start` is wired but not yet implemented (exits 2)", async () => {
    const code = await main(["start", "build a todo app"]);
    expect(code).toBe(2);
  });

  test("unknown command exits 64", async () => {
    const code = await main(["frobnicate"]);
    expect(code).toBe(64);
  });
});
