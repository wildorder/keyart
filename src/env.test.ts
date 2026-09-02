import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvFiles, upsertEnvFile, isGitignored } from "./env.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-env-"));
  delete process.env.OPENAI_API_KEY;
  delete process.env.FOO;
});

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.FOO;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadEnvFiles", () => {
  it("applies precedence with .env.local winning over .env", async () => {
    await fs.writeFile(path.join(tmp, ".env"), "OPENAI_API_KEY=from-env\n");
    await fs.writeFile(
      path.join(tmp, ".env.local"),
      "OPENAI_API_KEY=from-local\n",
    );

    const result = loadEnvFiles(tmp);

    expect(process.env.OPENAI_API_KEY).toBe("from-local");
    expect(result.loaded).toContain(".env");
    expect(result.loaded).toContain(".env.local");
    expect(result.keysSet).toContain("OPENAI_API_KEY");
  });

  it("never overrides a value already in the real environment", async () => {
    process.env.OPENAI_API_KEY = "real";
    await fs.writeFile(
      path.join(tmp, ".env.local"),
      "OPENAI_API_KEY=from-local\n",
    );

    const result = loadEnvFiles(tmp);

    expect(process.env.OPENAI_API_KEY).toBe("real");
    expect(result.keysSet).not.toContain("OPENAI_API_KEY");
  });

  it("parses comments, blank lines, quotes, and = inside values", async () => {
    await fs.writeFile(
      path.join(tmp, ".env"),
      ["# a comment", "", 'FOO="a=b"', "  # indented comment"].join("\n"),
    );

    const result = loadEnvFiles(tmp);

    expect(process.env.FOO).toBe("a=b");
    expect(result.loaded).toEqual([".env"]);
  });

  it("returns loaded: [] and does not throw when no env files exist", () => {
    const result = loadEnvFiles(tmp);
    expect(result.loaded).toEqual([]);
    expect(result.keysSet).toEqual([]);
  });
});

describe("upsertEnvFile", () => {
  it("creates the file, updates in place, and preserves unrelated lines", async () => {
    const file = path.join(tmp, "nested", ".env.local");

    await upsertEnvFile(file, { OPENAI_API_KEY: "k1" });
    expect(await fs.readFile(file, "utf-8")).toBe("OPENAI_API_KEY=k1\n");

    // Write an unrelated line/comment between the two upserts.
    const withExtra =
      (await fs.readFile(file, "utf-8")) + "# a note\nOTHER=keep\n";
    await fs.writeFile(file, withExtra);

    await upsertEnvFile(file, { OPENAI_API_KEY: "k2" });
    const content = await fs.readFile(file, "utf-8");

    const keyLines = content
      .split("\n")
      .filter((l) => l.startsWith("OPENAI_API_KEY="));
    expect(keyLines).toEqual(["OPENAI_API_KEY=k2"]);
    expect(content).toContain("# a note");
    expect(content).toContain("OTHER=keep");
  });

  it("double-quotes a value containing whitespace", async () => {
    const file = path.join(tmp, ".env.local");
    await upsertEnvFile(file, { NAME: "hello world" });
    expect(await fs.readFile(file, "utf-8")).toBe('NAME="hello world"\n');
  });
});

describe("isGitignored", () => {
  it("classifies the .env.* / !.env.example case and missing gitignore", async () => {
    await fs.writeFile(
      path.join(tmp, ".gitignore"),
      ["# env", ".env.*", "!.env.example"].join("\n"),
    );

    expect(await isGitignored(tmp, ".env.local")).toBe(true);
    expect(await isGitignored(tmp, ".env.example")).toBe(false);
    expect(await isGitignored(tmp, "keep.txt")).toBe(false);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-noign-"));
    expect(await isGitignored(empty, ".env.local")).toBe(false);
    await fs.rm(empty, { recursive: true, force: true });
  });
});
