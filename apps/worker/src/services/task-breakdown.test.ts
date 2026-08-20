import { describe, expect, it } from "vitest";
import { parseSteps } from "./task-breakdown.js";

describe("parseSteps", () => {
  it("extracts the step list from a well-formed reply", () => {
    const steps = parseSteps('{"steps":["Design schema","Write migration","Test it"]}');
    expect(steps).toEqual(["Design schema", "Write migration", "Test it"]);
  });

  it("returns nothing usable rather than throwing on malformed output", () => {
    // Each of these is something a model can plausibly emit; none should take
    // down the tool call — the caller reports "couldn't split this" instead.
    expect(parseSteps("not json at all")).toEqual([]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps('{"steps":"not an array"}')).toEqual([]);
    expect(parseSteps('{"other":["a"]}')).toEqual([]);
    expect(parseSteps('{"steps":[]}')).toEqual([]);
  });

  it("drops blanks, non-strings, and exact duplicates", () => {
    // Duplicates matter: two identical titles become two subtasks that can
    // never be told apart when ticking one off.
    const steps = parseSteps('{"steps":["Real step","  ","Real step",42,null,"Other step"]}');
    expect(steps).toEqual(["Real step", "Other step"]);
  });

  it("caps the number of steps so one bad reply can't create dozens of rows", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Step ${i}`);
    expect(parseSteps(JSON.stringify({ steps: many }))).toHaveLength(8);
  });

  it("truncates an over-long step title to what the schema accepts", () => {
    const steps = parseSteps(JSON.stringify({ steps: ["x".repeat(500)] }));
    expect(steps[0]).toHaveLength(200);
  });
});
