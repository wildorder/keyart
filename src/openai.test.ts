import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  hasApiKey,
  createClient,
  configureModelClient,
  chatJson,
  visionJson,
  generateImage,
  analyzeReferenceForTokens,
  describeImageBrand,
  detectContradictionsLLM,
  classifySurfaceCandidates,
} from "./openai.js";

// Shared mock fns so each test can control the fake client's behavior.
// Hoisted so the (also-hoisted) vi.mock factory can reference them.
const { chatCreate, imagesGenerate, imagesEdit, toFile, ctorSpy } = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  imagesGenerate: vi.fn(),
  imagesEdit: vi.fn(),
  ctorSpy: vi.fn(),
  toFile: vi.fn(
    async (buffer: Buffer, name: string, opts?: { type?: string }) => ({
      name,
      type: opts?.type,
      buffer,
    }),
  ),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    constructor(...args: unknown[]) {
      ctorSpy(...args);
    }
    chat = { completions: { create: chatCreate } };
    images = { generate: imagesGenerate, edit: imagesEdit };
    static toFile = toFile;
  }
  return { default: MockOpenAI };
});

// A 1x1 png byte payload — just needs to be readable bytes on disk.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d49444154789c6360000002000100",
  "hex",
);

let tmpDir: string;

async function writePng(name: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, PNG_BYTES);
  return p;
}

const originalKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-openai-"));
  chatCreate.mockReset();
  imagesGenerate.mockReset();
  imagesEdit.mockReset();
  toFile.mockClear();
});

afterEach(async () => {
  if (originalKey !== undefined) {
    process.env.OPENAI_API_KEY = originalKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hasApiKey", () => {
  it("returns false when OPENAI_API_KEY is unset", () => {
    delete process.env.OPENAI_API_KEY;
    expect(hasApiKey()).toBe(false);
  });

  it("returns true when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "test";
    expect(hasApiKey()).toBe(true);
  });

  it("returns false when OPENAI_API_KEY is empty string", () => {
    process.env.OPENAI_API_KEY = "";
    expect(hasApiKey()).toBe(false);
  });
});

describe("chatJson dry-run", () => {
  it("returns dryRun: true and null data when no API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await chatJson<{ foo: string }>({
      model: "gpt-5.5",
      system: "You are a test.",
      user: "Hello",
    });
    expect(result.dryRun).toBe(true);
    expect(result.data).toBeNull();
    expect(chatCreate).not.toHaveBeenCalled();
  });
});

describe("visionJson", () => {
  it("dry-run: no key ⇒ { data: null, dryRun: true }, no client call", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await visionJson<{ ok: boolean }>({
      model: "gpt-5.5",
      system: "sys",
      user: "u",
      imagePaths: ["does-not-need-to-exist.png"],
    });
    expect(result.dryRun).toBe(true);
    expect(result.data).toBeNull();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("single imagePath (back-compat): one image_url + one text entry", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
    const p = await writePng("a.png");
    const result = await visionJson<{ ok: boolean }>({
      model: "gpt-5.5",
      system: "sys",
      user: "u",
      imagePath: p,
    });
    expect(result.dryRun).toBe(false);
    expect(result.data).toEqual({ ok: true });

    const content = chatCreate.mock.calls[0][0].messages[1].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(content[1]).toEqual({ type: "text", text: "u" });
  });

  it("multi-image: three image_url entries then the text entry, in order", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
    });
    const p1 = await writePng("1.png");
    const p2 = await writePng("2.png");
    const p3 = await writePng("3.png");
    await visionJson({
      model: "gpt-5.5",
      system: "sys",
      user: "the-text",
      imagePaths: [p1, p2, p3],
    });

    const content = chatCreate.mock.calls[0][0].messages[1].content;
    expect(content).toHaveLength(4);
    expect(content.slice(0, 3).map((c: { type: string }) => c.type)).toEqual([
      "image_url",
      "image_url",
      "image_url",
    ]);
    expect(content[3]).toEqual({ type: "text", text: "the-text" });
  });

  it("caps images at MAX_VISION_IMAGES (6)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
    });
    const paths: string[] = [];
    for (let i = 0; i < 9; i++) {
      paths.push(await writePng(`img-${i}.png`));
    }
    await visionJson({
      model: "gpt-5.5",
      system: "sys",
      user: "u",
      imagePaths: paths,
    });

    const content = chatCreate.mock.calls[0][0].messages[1].content;
    const imageEntries = content.filter(
      (c: { type: string }) => c.type === "image_url",
    );
    expect(imageEntries).toHaveLength(6);
  });
});

describe("analyzeReferenceForTokens", () => {
  it("dry-run: no key ⇒ { dryRun: true, analysis: { dominantColors: [] } }, no throw", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await analyzeReferenceForTokens({
      model: "gpt-5.5",
      imagePaths: ["does-not-need-to-exist.png"],
    });
    expect(result.dryRun).toBe(true);
    expect(result.analysis).toEqual({ dominantColors: [] });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("parses a vision read into dominant colors + type intent", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              dominantColors: ["#112233", "#445566"],
              typeIntent: { style: "editorial serif", suggestedPairing: "Playfair/Inter" },
            }),
          },
        },
      ],
    });
    const p = await writePng("ref.png");

    const result = await analyzeReferenceForTokens({
      model: "gpt-5.5",
      imagePaths: [p],
    });
    expect(result.dryRun).toBe(false);
    expect(result.analysis.dominantColors).toEqual(["#112233", "#445566"]);
    expect(result.analysis.typeIntent).toEqual({
      style: "editorial serif",
      suggestedPairing: "Playfair/Inter",
    });
    // The reference was analyzed via a vision call — never an image-edit source.
    expect(imagesEdit).not.toHaveBeenCalled();
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it("degrades to an empty analysis (never throws) when the model returns junk", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"dominantColors":"not-an-array"}' } }],
    });
    const p = await writePng("ref2.png");

    const result = await analyzeReferenceForTokens({
      model: "gpt-5.5",
      imagePaths: [p],
    });
    expect(result.dryRun).toBe(false);
    expect(result.analysis).toEqual({ dominantColors: [] });
  });
});

describe("describeImageBrand", () => {
  it("dry-run: no key ⇒ empty read, dryRun: true, no client call", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await describeImageBrand({
      model: "gpt-5.5",
      imagePaths: ["does-not-need-to-exist.png"],
    });
    expect(result.dryRun).toBe(true);
    expect(result.read).toEqual({ colors: [], type: {} });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("parses role-tagged colors, deriving the flat palette from them", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              colors: [
                { hex: "#0e382e", role: "background", label: "Forest" },
                { hex: "#fff6e6", role: "text", label: "Cream" },
                { hex: "#ff2d8d", role: "primary", label: "Hot Pink" },
                { hex: "#ff6a00", role: "brand", label: "Orange" },
                { hex: "#a98cff", role: "bogus-role" },
              ],
              type: { printedFamilies: { heading: "Baloo 2" } },
            }),
          },
        },
      ],
    });
    const p = await writePng("roled.png");

    const result = await describeImageBrand({ model: "gpt-5.5", imagePaths: [p] });
    expect(result.dryRun).toBe(false);
    // Roles come straight from the model — background is the DARK color here.
    expect(result.read.colors).toEqual([
      { hex: "#0e382e", role: "background", label: "Forest" },
      { hex: "#fff6e6", role: "text", label: "Cream" },
      { hex: "#ff2d8d", role: "primary", label: "Hot Pink" },
      { hex: "#ff6a00", role: "brand", label: "Orange" },
      // An unknown role degrades to the open "brand" bucket, not dropped.
      { hex: "#a98cff", role: "brand" },
    ]);
  });

  it("accepts a directly-tagged secondary and preserves repeated brand colors (WS-02)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              colors: [
                { hex: "#ff2d8d", role: "primary" },
                { hex: "#008080", role: "secondary" },
                { hex: "#ff6a00", role: "brand" },
                { hex: "#ffd600", role: "brand" },
              ],
              type: {},
            }),
          },
        },
      ],
    });
    const p = await writePng("secondary.png");

    const result = await describeImageBrand({ model: "gpt-5.5", imagePaths: [p] });
    expect(result.dryRun).toBe(false);
    // `secondary` is now a universal role the parser keeps verbatim, and `brand`
    // may still repeat any number of times (no fixed cap).
    expect(result.read.colors).toEqual([
      { hex: "#ff2d8d", role: "primary" },
      { hex: "#008080", role: "secondary" },
      { hex: "#ff6a00", role: "brand" },
      { hex: "#ffd600", role: "brand" },
    ]);
  });

  it("reads the typography panel alongside the tagged colors", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              colors: [{ hex: "#ff2d8d", role: "primary" }],
              type: {
                printedFamilies: { heading: "Baloo 2", body: "Nunito Sans" },
                attributes: { classification: "sans", mood: "friendly rounded" },
                suggestedFamily: "Baloo 2",
              },
            }),
          },
        },
      ],
    });
    const p = await writePng("tile.png");

    const result = await describeImageBrand({
      model: "gpt-5.5",
      imagePaths: [p],
    });
    expect(result.dryRun).toBe(false);
    expect(result.read.colors).toEqual([{ hex: "#ff2d8d", role: "primary" }]);
    expect(result.read.type.printedFamilies).toEqual({
      heading: "Baloo 2",
      body: "Nunito Sans",
    });
    expect(result.read.type.attributes?.classification).toBe("sans");
    expect(result.read.type.suggestedFamily).toBe("Baloo 2");
    // A generated tile is read via a vision call — never an image-edit source.
    expect(imagesEdit).not.toHaveBeenCalled();
    expect(imagesGenerate).not.toHaveBeenCalled();
  });

  it("degrades to an empty read (never throws) when the model returns junk", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"palette":"not-an-array"}' } }],
    });
    const p = await writePng("tile2.png");

    const result = await describeImageBrand({
      model: "gpt-5.5",
      imagePaths: [p],
    });
    expect(result.dryRun).toBe(false);
    expect(result.read).toEqual({ colors: [], type: {} });
  });
});

describe("generateImage", () => {
  it("dry-run: no key ⇒ { written: false, dryRun: true }, no write", async () => {
    delete process.env.OPENAI_API_KEY;
    const outPath = path.join(tmpDir, "out.png");
    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
    });
    expect(result).toEqual({ written: false, dryRun: true });
    expect(imagesGenerate).not.toHaveBeenCalled();
    await expect(fs.access(outPath)).rejects.toBeTruthy();
  });

  it("prompt-only: calls images.generate, decodes b64, writes the file", async () => {
    process.env.OPENAI_API_KEY = "test";
    const b64 = PNG_BYTES.toString("base64");
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: b64 }] });
    const outPath = path.join(tmpDir, "nested", "out.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
    });
    expect(result).toEqual({ written: true, dryRun: false });
    expect(imagesGenerate).toHaveBeenCalledTimes(1);
    expect(imagesEdit).not.toHaveBeenCalled();
    const written = await fs.readFile(outPath);
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it("with references: calls images.edit with an image array of two files", async () => {
    process.env.OPENAI_API_KEY = "test";
    const b64 = PNG_BYTES.toString("base64");
    imagesEdit.mockResolvedValue({ data: [{ b64_json: b64 }] });
    const p1 = await writePng("ref1.png");
    const p2 = await writePng("ref2.png");
    const outPath = path.join(tmpDir, "styled.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "style tile",
      outPath,
      referenceImagePaths: [p1, p2],
    });
    expect(result).toEqual({ written: true, dryRun: false });
    expect(imagesGenerate).not.toHaveBeenCalled();
    expect(imagesEdit).toHaveBeenCalledTimes(1);
    const args = imagesEdit.mock.calls[0][0];
    expect(args.prompt).toBe("style tile");
    expect(Array.isArray(args.image)).toBe(true);
    expect(args.image).toHaveLength(2);
    expect(toFile).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(outPath)).toBeTruthy();
  });

  it("single reference: passes a single file (not an array) to images.edit", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit.mockResolvedValue({
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    });
    const p1 = await writePng("ref1.png");
    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "style tile",
      outPath: path.join(tmpDir, "styled.png"),
      referenceImagePaths: [p1],
    });
    expect(result.written).toBe(true);
    const args = imagesEdit.mock.calls[0][0];
    expect(Array.isArray(args.image)).toBe(false);
  });

  it("graceful skip: rejected call ⇒ skippedReason, no throw, no write", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit.mockRejectedValue(new Error("model not entitled"));
    const p1 = await writePng("ref1.png");
    const outPath = path.join(tmpDir, "styled.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "style tile",
      outPath,
      referenceImagePaths: [p1],
    });
    expect(result).toEqual({
      written: false,
      dryRun: false,
      skippedReason: "model not entitled",
    });
    await expect(fs.access(outPath)).rejects.toBeTruthy();
  });

  it("background rejected ⇒ ONE retry without the param, written + warning", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit
      .mockRejectedValueOnce(
        new Error("400 Transparent background is not supported for this model."),
      )
      .mockResolvedValueOnce({
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
      });
    const p1 = await writePng("ref1.png");
    const outPath = path.join(tmpDir, "styled.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "isolate the yak",
      outPath,
      referenceImagePaths: [p1],
      transparentBackground: true,
    });

    expect(result.written).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(/transparent background is not supported/i);
    expect(imagesEdit).toHaveBeenCalledTimes(2);
    expect(imagesEdit.mock.calls[0][0]).toHaveProperty("background", "transparent");
    expect(imagesEdit.mock.calls[1][0]).not.toHaveProperty("background");
    await expect(fs.access(outPath)).resolves.toBeUndefined();
  });

  it("background rejected AND the retry fails ⇒ skippedReason from the retry + the warning", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit
      .mockRejectedValueOnce(
        new Error("Transparent background is not supported for this model."),
      )
      .mockRejectedValueOnce(new Error("rate limited"));
    const p1 = await writePng("ref1.png");
    const outPath = path.join(tmpDir, "styled.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "isolate the yak",
      outPath,
      referenceImagePaths: [p1],
      transparentBackground: true,
    });

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe("rate limited");
    expect(result.warnings?.[0]).toMatch(/transparent background is not supported/i);
    expect(imagesEdit).toHaveBeenCalledTimes(2);
    await expect(fs.access(outPath)).rejects.toBeTruthy();
  });

  it("a NON-background error with transparentBackground set is NOT retried", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit.mockRejectedValue(new Error("model not entitled"));
    const p1 = await writePng("ref1.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "isolate the yak",
      outPath: path.join(tmpDir, "styled.png"),
      referenceImagePaths: [p1],
      transparentBackground: true,
    });

    expect(result.written).toBe(false);
    expect(result.skippedReason).toBe("model not entitled");
    expect(result.warnings).toBeUndefined();
    expect(imagesEdit).toHaveBeenCalledTimes(1);
  });

  it("empty response: no image data ⇒ skippedReason", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesGenerate.mockResolvedValue({ data: [] });
    const outPath = path.join(tmpDir, "out.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
    });
    expect(result.written).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.skippedReason).toMatch(/no image data/i);
    await expect(fs.access(outPath)).rejects.toBeTruthy();
  });

  it("transparentBackground + references: images.edit is called with background: \"transparent\"", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesEdit.mockResolvedValue({
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    });
    const p1 = await writePng("ref1.png");
    const outPath = path.join(tmpDir, "styled.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "style tile",
      outPath,
      referenceImagePaths: [p1],
      transparentBackground: true,
    });
    expect(result.written).toBe(true);
    expect(imagesEdit).toHaveBeenCalledTimes(1);
    expect(imagesEdit.mock.calls[0][0].background).toBe("transparent");
  });

  it("transparentBackground prompt-only: images.generate is called with background: \"transparent\"", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesGenerate.mockResolvedValue({
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    });
    const outPath = path.join(tmpDir, "out.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
      transparentBackground: true,
    });
    expect(result.written).toBe(true);
    expect(imagesGenerate).toHaveBeenCalledTimes(1);
    expect(imagesGenerate.mock.calls[0][0].background).toBe("transparent");
  });

  it("option absent: the request param object carries NO background key (unchanged default)", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesGenerate.mockResolvedValue({
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    });
    const outPath = path.join(tmpDir, "out.png");

    await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
    });
    expect("background" in imagesGenerate.mock.calls[0][0]).toBe(false);

    imagesEdit.mockResolvedValue({
      data: [{ b64_json: PNG_BYTES.toString("base64") }],
    });
    const p1 = await writePng("ref1.png");
    await generateImage({
      model: "gpt-image-2",
      prompt: "style tile",
      outPath: path.join(tmpDir, "styled.png"),
      referenceImagePaths: [p1],
    });
    expect("background" in imagesEdit.mock.calls[0][0]).toBe(false);
  });

  it("dry-run untouched: no key + transparentBackground: true ⇒ { written: false, dryRun: true }, no client call", async () => {
    delete process.env.OPENAI_API_KEY;
    const outPath = path.join(tmpDir, "out.png");
    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
      transparentBackground: true,
    });
    expect(result).toEqual({ written: false, dryRun: true });
    expect(imagesGenerate).not.toHaveBeenCalled();
    expect(imagesEdit).not.toHaveBeenCalled();
  });

  it("falls back to url when b64_json is absent", async () => {
    process.env.OPENAI_API_KEY = "test";
    imagesGenerate.mockResolvedValue({
      data: [{ url: "https://example.test/img.png" }],
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(PNG_BYTES) as unknown as Response,
      );
    const outPath = path.join(tmpDir, "out.png");

    const result = await generateImage({
      model: "gpt-image-2",
      prompt: "a logo",
      outPath,
    });
    expect(result).toEqual({ written: true, dryRun: false });
    expect(fetchSpy).toHaveBeenCalledWith("https://example.test/img.png");
    fetchSpy.mockRestore();
  });
});

describe("detectContradictionsLLM — semantic adapter (SC-07 tests 8-10)", () => {
  const OPTS = {
    model: "gpt-5.5",
    liveInstruction: "make the background pure black",
    hardRules: [{ id: "r1", text: "Never use pure black" }],
    guidelines: [],
    memory: [{ id: "m1", kind: "feedback", body: "loves warm tones" }],
  };

  it("no key ⇒ { contradictions: [], dryRun: true } — never calls the client (test 8)", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await detectContradictionsLLM(OPTS);
    expect(result).toEqual({ contradictions: [], dryRun: true });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("parses a mocked well-formed JSON response into Contradiction[] (test 9)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              contradictions: [
                {
                  kind: "live-vs-hardrule",
                  subject: { source: "live", id: "live-1", text: "make it pure black" },
                  conflictsWith: { source: "hard-rule", id: "r1", text: "Never use pure black" },
                  severity: "warning",
                  explanation: "The live instruction directly contradicts the hard rule.",
                  suggestions: ["keep"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await detectContradictionsLLM(OPTS);
    expect(result.dryRun).toBe(false);
    expect(result.contradictions).toHaveLength(1);
    const c = result.contradictions[0];
    expect(c.kind).toBe("live-vs-hardrule");
    expect(c.subject.source).toBe("live");
    expect(c.conflictsWith.source).toBe("hard-rule");
    expect(c.conflictsWith.id).toBe("r1");
    expect(c.severity).toBe("warning");
    expect(c.suggestions).toEqual(["keep"]);
    expect(c.id).toBe("live-vs-hardrule::live-1::r1");
  });

  it("drops invalid entries: unknown kind / severity / action / missing id (test 9 — defensive parse)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              contradictions: [
                // Valid entry
                {
                  kind: "live-vs-hardrule",
                  subject: { source: "live", id: "live-1", text: "pure black" },
                  conflictsWith: { source: "hard-rule", id: "r1", text: "Never pure black" },
                  severity: "warning",
                  explanation: "OK",
                  suggestions: ["keep", "INVALID_ACTION"],
                },
                // Unknown kind → dropped
                {
                  kind: "BOGUS_KIND",
                  subject: { source: "live", id: "live-1", text: "x" },
                  conflictsWith: { source: "hard-rule", id: "r1", text: "y" },
                  severity: "warning",
                  explanation: "Dropped.",
                  suggestions: [],
                },
                // Invalid ref id (not in supplied records) → dropped
                {
                  kind: "live-vs-memory",
                  subject: { source: "live", id: "live-2", text: "x" },
                  conflictsWith: { source: "memory", id: "NOT_A_REAL_ID", text: "y" },
                  severity: "info",
                  explanation: "Should be dropped.",
                  suggestions: ["retire"],
                },
              ],
            }),
          },
        },
      ],
    });

    const result = await detectContradictionsLLM(OPTS);
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0].kind).toBe("live-vs-hardrule");
    // INVALID_ACTION is dropped from suggestions; "keep" survives
    expect(result.contradictions[0].suggestions).toEqual(["keep"]);
  });

  it("a thrown response degrades to [] (never throws) (test 10)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockRejectedValue(new Error("network error"));

    const result = await detectContradictionsLLM(OPTS);
    expect(result).toEqual({ contradictions: [], dryRun: false });
  });

  it("garbled (non-object) JSON response degrades to [] (test 10)", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '"just a string"' } }],
    });

    const result = await detectContradictionsLLM(OPTS);
    expect(result.contradictions).toEqual([]);
    expect(result.dryRun).toBe(false);
  });
});

// surface-manifest WS-06's Test 9: the seam itself, real implementation,
// keyless + validation (mocking `visionJson` directly is not possible from
// here — it's a same-module internal call, not an import — so this drives it
// through the MockOpenAI client, same as its describeImageBrand/
// analyzeReferenceForTokens siblings above).
describe("classifySurfaceCandidates", () => {
  const TAXONOMY = "icon | illustration | color-role | type-role | other";

  it("dry-run: no key ⇒ { candidates: [], dryRun: true }, no file reads", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await classifySurfaceCandidates({
      model: "gpt-5.5",
      candidates: [
        {
          signature: "sig1",
          kind: "icon",
          cropPath: path.join(tmpDir, "does-not-exist.png"),
          hints: {},
        },
      ],
      taxonomy: TAXONOMY,
    });
    expect(result).toEqual({ candidates: [], dryRun: true });
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("keeps only well-typed suggestions for sent signatures, dropping malformed/unknown items", async () => {
    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidates: [
                { suggestedId: "icon.no-signature" }, // missing signature — dropped entirely
                { signature: "unknown-sig", suggestedId: "icon.ghost" }, // unsent signature — dropped entirely
                { signature: "sig1", suggestedId: 42, description: "A restaurant glyph" }, // numeric field ignored, not fabricated into a string
              ],
            }),
          },
        },
      ],
    });
    const p = await writePng("sig1.png");

    const result = await classifySurfaceCandidates({
      model: "gpt-5.5",
      candidates: [{ signature: "sig1", kind: "icon", cropPath: p, hints: {} }],
      taxonomy: TAXONOMY,
    });

    expect(result.dryRun).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].signature).toBe("sig1");
    expect(result.candidates[0].suggestedId).toBeUndefined();
    expect(result.candidates[0].description).toBe("A restaurant glyph");
  });

  it("chunks candidates through visionJson at MAX_VISION_IMAGES and aggregates across chunks", async () => {
    process.env.OPENAI_API_KEY = "test";
    const paths = await Promise.all(Array.from({ length: 7 }, (_, i) => writePng(`c${i}.png`)));
    chatCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidates: [{ signature: "c0", suggestedId: "icon.zero" }],
              }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidates: [{ signature: "c6", suggestedId: "icon.six" }],
              }),
            },
          },
        ],
      });

    const result = await classifySurfaceCandidates({
      model: "gpt-5.5",
      candidates: paths.map((p, i) => ({
        signature: `c${i}`,
        kind: "icon",
        cropPath: p,
        hints: {},
      })),
      taxonomy: TAXONOMY,
    });

    expect(chatCreate).toHaveBeenCalledTimes(2); // 7 candidates → chunks of 6 + 1
    expect(result.candidates).toEqual([
      { signature: "c0", suggestedId: "icon.zero" },
      { signature: "c6", suggestedId: "icon.six" },
    ]);
  });

  it("every chunk failing surfaces a skippedReason; never throws", async () => {
    process.env.OPENAI_API_KEY = "test";
    const p = await writePng("fail.png");
    chatCreate.mockRejectedValue(new Error("model unavailable"));

    const result = await classifySurfaceCandidates({
      model: "gpt-5.5",
      candidates: [{ signature: "sig1", kind: "icon", cropPath: p, hints: {} }],
      taxonomy: TAXONOMY,
    });
    expect(result).toEqual({
      candidates: [],
      dryRun: false,
      skippedReason: "model unavailable",
    });
  });
});

describe("configureModelClient", () => {
  it("passes a configured baseURL to the OpenAI constructor; clearing it restores default construction", () => {
    process.env.OPENAI_API_KEY = "test";
    try {
      configureModelClient({ baseURL: "https://example.com/v1" });
      expect(createClient()).not.toBeNull();
      expect(ctorSpy).toHaveBeenLastCalledWith({
        baseURL: "https://example.com/v1",
      });

      configureModelClient({});
      expect(createClient()).not.toBeNull();
      expect(ctorSpy).toHaveBeenLastCalledWith();
    } finally {
      configureModelClient({}); // never leak module state into other tests
    }
  });

  it("keyless createClient stays null regardless of configured options", () => {
    delete process.env.OPENAI_API_KEY;
    try {
      configureModelClient({ baseURL: "https://example.com/v1" });
      expect(createClient()).toBeNull();
    } finally {
      configureModelClient({});
    }
  });

  it("an injected apiKey satisfies hasApiKey and reaches the constructor — env var not required", () => {
    delete process.env.OPENAI_API_KEY;
    try {
      configureModelClient({ apiKey: "sk-tenant-abc" });
      expect(hasApiKey()).toBe(true);
      expect(createClient()).not.toBeNull();
      expect(ctorSpy).toHaveBeenLastCalledWith({ apiKey: "sk-tenant-abc" });

      configureModelClient({
        apiKey: "sk-tenant-abc",
        baseURL: "https://example.com/v1",
      });
      createClient();
      expect(ctorSpy).toHaveBeenLastCalledWith({
        baseURL: "https://example.com/v1",
        apiKey: "sk-tenant-abc",
      });
    } finally {
      configureModelClient({});
    }
  });

  it("onUsage receives provider-neutral token counts from a chat response", async () => {
    process.env.OPENAI_API_KEY = "test";
    const onUsage = vi.fn();
    try {
      configureModelClient({ onUsage });
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      });
      await chatJson({ model: "gpt-5.5", system: "s", user: "u" });
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({
        model: "gpt-5.5",
        promptTokens: 42,
        completionTokens: 7,
      });
    } finally {
      configureModelClient({});
    }
  });

  it("a response without a usage block calls no hook; a throwing hook never breaks the call", async () => {
    process.env.OPENAI_API_KEY = "test";
    const onUsage = vi.fn();
    try {
      configureModelClient({ onUsage });
      chatCreate.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
      await chatJson({ model: "gpt-5.5", system: "s", user: "u" });
      expect(onUsage).not.toHaveBeenCalled();

      configureModelClient({
        onUsage: () => {
          throw new Error("meter exploded");
        },
      });
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
      const result = await chatJson<{ ok: boolean }>({
        model: "gpt-5.5",
        system: "s",
        user: "u",
      });
      expect(result.data).toEqual({ ok: true });
    } finally {
      configureModelClient({});
    }
  });

  it("onUsage normalizes the Images API's input/output token names", async () => {
    process.env.OPENAI_API_KEY = "test";
    const onUsage = vi.fn();
    try {
      configureModelClient({ onUsage });
      imagesGenerate.mockResolvedValue({
        data: [{ b64_json: PNG_BYTES.toString("base64") }],
        usage: { input_tokens: 12, output_tokens: 3400 },
      });
      const outPath = path.join(tmpDir, "usage-out.png");
      const result = await generateImage({
        model: "gpt-image-2",
        prompt: "p",
        outPath,
      });
      expect(result.written).toBe(true);
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({
        model: "gpt-image-2",
        promptTokens: 12,
        completionTokens: 3400,
      });
    } finally {
      configureModelClient({});
    }
  });
});
