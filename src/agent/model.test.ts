import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { ChatMessage, CompletionChunk } from "./model.js";

const { chatCreate } = vi.hoisted(() => ({
  chatCreate: vi.fn(),
}));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: chatCreate } };
  }
  return { default: MockOpenAI };
});

const originalKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  chatCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  if (originalKey !== undefined) {
    process.env.OPENAI_API_KEY = originalKey;
  } else {
    delete process.env.OPENAI_API_KEY;
  }
});

/** Wraps plain chunk objects into an async iterable, mirroring the OpenAI SDK's stream shape. */
function fakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) {
            return { value: chunks[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

async function collect(iter: AsyncIterable<CompletionChunk>): Promise<CompletionChunk[]> {
  const out: CompletionChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const SYSTEM: ChatMessage = { role: "system", content: "sys" };

describe("model.ts createComplete", () => {
  it("streams text-deltas then a done with the assembled turn", async () => {
    chatCreate.mockResolvedValue(
      fakeStream([
        { choices: [{ delta: { content: "Make " } }] },
        { choices: [{ delta: { content: "the CTA " } }] },
        { choices: [{ delta: { content: "warmer" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "direction_feedback", arguments: '{"body":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"warmer"}' } }],
              },
            },
          ],
        },
      ]),
    );

    const { createComplete } = await import("./model.js");
    const complete = createComplete();
    const chunks = await collect(complete([SYSTEM], []));

    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.map((c) => (c as { text: string }).text)).toEqual([
      "Make ",
      "the CTA ",
      "warmer",
    ]);

    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    const turn = (done as { turn: import("./model.js").AssistantTurn }).turn;
    expect(turn.content).toBe("Make the CTA warmer");
    expect(turn.toolCalls).toEqual([
      { id: "call_1", toolName: "direction_feedback", arguments: { body: "warmer" } },
    ]);
  });

  it("a no-tool stream yields only text-deltas + a done.turn with toolCalls: []", async () => {
    chatCreate.mockResolvedValue(
      fakeStream([
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: {} }] },
      ]),
    );

    const { createComplete } = await import("./model.js");
    const complete = createComplete();
    const chunks = await collect(complete([SYSTEM], []));

    expect(chunks.filter((c) => c.type === "text-delta")).toHaveLength(1);
    const done = chunks.find((c) => c.type === "done");
    const turn = (done as { turn: import("./model.js").AssistantTurn }).turn;
    expect(turn.toolCalls).toEqual([]);
  });

  it("malformed streamed arguments degrade to {}", async () => {
    chatCreate.mockResolvedValue(
      fakeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "direction_feedback", arguments: "not json" },
                  },
                ],
              },
            },
          ],
        },
      ]),
    );

    const { createComplete } = await import("./model.js");
    const complete = createComplete();
    const chunks = await collect(complete([SYSTEM], []));
    const done = chunks.find((c) => c.type === "done");
    const turn = (done as { turn: import("./model.js").AssistantTurn }).turn;
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].arguments).toEqual({});
  });

  it("keyless yields an explicit unavailable outcome, never a fabricated turn", async () => {
    delete process.env.OPENAI_API_KEY;
    const { createComplete, ChatUnavailableError } = await import("./model.js");
    const complete = createComplete();

    await expect(async () => {
      for await (const _ of complete([SYSTEM], [])) {
        // draining the generator triggers the throw
      }
    }).rejects.toThrow(ChatUnavailableError);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("forwards tools + tool_choice + stream + the configured model", async () => {
    chatCreate.mockResolvedValue(fakeStream([{ choices: [{ delta: { content: "hi" } }] }]));

    const { createComplete } = await import("./model.js");
    const complete = createComplete({ model: "gpt-custom" });
    const tools = [{ type: "function", function: { name: "direction_list" } }];
    await collect(complete([SYSTEM], tools));

    expect(chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-custom",
        tools,
        tool_choice: "auto",
        stream: true,
      }),
    );
  });
});
