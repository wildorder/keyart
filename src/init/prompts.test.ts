import { describe, it, expect } from "vitest";
import {
  askDefault,
  askYesNo,
  askChoice,
  type WizardIO,
} from "./prompts.js";

/** A fake WizardIO that returns queued answers and records prompts. */
function fakeIO(answers: string[]): WizardIO & { calls: string[] } {
  const queue = [...answers];
  const calls: string[] = [];
  return {
    calls,
    question(prompt: string): Promise<string> {
      calls.push(prompt);
      return Promise.resolve(queue.shift() ?? "");
    },
    close(): void {},
  };
}

describe("askDefault", () => {
  it("returns the default on empty input and the answer otherwise", async () => {
    expect(await askDefault(fakeIO([""]), "Name", "def")).toBe("def");
    expect(await askDefault(fakeIO(["custom"]), "Name", "def")).toBe("custom");
  });
});

describe("askYesNo", () => {
  it("returns the default on empty input", async () => {
    expect(await askYesNo(fakeIO([""]), "OK?", true)).toBe(true);
    expect(await askYesNo(fakeIO([""]), "OK?", false)).toBe(false);
  });

  it("accepts y/yes/n/no case-insensitively", async () => {
    expect(await askYesNo(fakeIO(["y"]), "OK?", false)).toBe(true);
    expect(await askYesNo(fakeIO(["YES"]), "OK?", false)).toBe(true);
    expect(await askYesNo(fakeIO(["n"]), "OK?", true)).toBe(false);
    expect(await askYesNo(fakeIO(["No"]), "OK?", true)).toBe(false);
  });
});

describe("askChoice", () => {
  const choices = ["Red", "Green", "Blue"];

  it("returns choices[defaultIndex] on empty input", async () => {
    expect(await askChoice(fakeIO([""]), "Color", choices, 1)).toBe("Green");
  });

  it("accepts a valid 1-based number", async () => {
    expect(await askChoice(fakeIO(["3"]), "Color", choices)).toBe("Blue");
  });

  it("accepts an exact choice value case-insensitively", async () => {
    expect(await askChoice(fakeIO(["green"]), "Color", choices)).toBe("Green");
  });

  it("re-prompts on invalid input then resolves the valid choice", async () => {
    const io = fakeIO(["nope", "2"]);
    expect(await askChoice(io, "Color", choices)).toBe("Green");
    expect(io.calls.length).toBeGreaterThan(1);
  });
});
