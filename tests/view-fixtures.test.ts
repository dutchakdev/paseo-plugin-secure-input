import { describe, expect, it } from "vitest";
import { RequestViewSchema } from "../shared/view";
import { file, text, view, viewOf } from "./view-fixtures";

// The fixtures are typed, but a type is not the contract: these go through the schema the daemon's answers go through,
// so a fixture cannot drift from what the form is really given.
describe("the fixtures the client tests share", () => {
  it("are accepted, unchanged, by the schema of the contract", () => {
    expect(RequestViewSchema.parse(viewOf())).toEqual(viewOf());
    const mixed = view([text("API_KEY", false, "з панелі"), file("SA", "json"), file("BLOB"), text("OPT", true)]);
    expect(RequestViewSchema.parse(mixed)).toEqual(mixed);
  });

  it("are refused by the schema when a member is missing or one more rides along, so the check above can fail", () => {
    for (const name of Object.keys(viewOf())) {
      const { [name]: _left, ...without } = viewOf() as unknown as Record<string, unknown>;
      expect(RequestViewSchema.safeParse(without).success, name).toBe(false);
    }
    expect(RequestViewSchema.safeParse({ ...viewOf(), extra: 1 }).success).toBe(false);
    expect(RequestViewSchema.safeParse(view([{ ...text("A"), extra: 1 } as never])).success).toBe(false);
  });

  it("are refused when they carry what v1's view had: a destination, its digests, a receipt, the agent's words", () => {
    const v1: Record<string, unknown> = {
      facts: null,
      factsDigest: "",
      sinkDigest: "d".repeat(64),
      receipt: null,
      problem: null,
      problemDetail: null,
      allowExtraRows: true,
      agentTitle: "Agent",
      reason: "To run the tests",
    };
    for (const [name, value] of Object.entries(v1)) {
      expect(RequestViewSchema.safeParse({ ...viewOf(), [name]: value }).success, name).toBe(false);
    }
  });
});
