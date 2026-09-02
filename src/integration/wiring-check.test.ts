/**
 * WS-19: proof suite for the two-mode wiring analyzer (SC-09).
 *
 * Fixtures are inline template-literal source-text constants — modules this
 * suite writes itself and feeds to the core functions as `sourceText`. No
 * standalone `.tsx` fixture files (the root tsconfig includes only
 * `src/**\/*.ts` and vitest only `src/**\/*.test.ts`, so a fixture file would
 * be checked and run by nothing). Fixtures import nothing real — the analyzer
 * never resolves modules — so they freely reference a fictional `myBuilder`,
 * `useEffect`, and `useCallback`.
 *
 * Network-free, key-free, browser-free. The only filesystem use is the
 * convenience-wrapper smoke's temp dir, cleaned up in `afterEach`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkJsxEventWiring,
  checkEffectWiring,
  checkJsxEventWiringFile,
  checkEffectWiringFile,
} from "./wiring-check.js";

const FILE = "fixture.tsx";

function jsx(sourceText: string, eventAttribute: string, identifier = "myBuilder") {
  return checkJsxEventWiring({ fileName: FILE, sourceText, eventAttribute, identifier });
}

function effect(sourceText: string, identifier = "myBuilder") {
  return checkEffectWiring({ fileName: FILE, sourceText, identifier });
}

// ---------------------------------------------------------------------------
// Negative controls — mandated verbatim by the manifest; each must fail BOTH
// modes. These are the proof the analyzer discriminates.
// ---------------------------------------------------------------------------

// N1 — module-scope call: myBuilder() invoked at module scope; the module also
// has JSX with the queried attribute bound to an UNRELATED handler, and a
// useEffect referencing something else.
const N1 = `
import { myBuilder, other } from "./api.js";
myBuilder();
function unrelatedHandler() { other(); }
export function View() {
  useEffect(() => { void other(); }, []);
  return <button onClick={unrelatedHandler}>go</button>;
}
`;

// N2 — unused local callback: declares the handler and calls the builder, but
// is bound to NO JSX attribute and referenced by NO effect.
const N2 = `
import { myBuilder, other } from "./api.js";
function unrelatedHandler() { other(); }
export function View() {
  const unusedHandler = () => { void myBuilder(); };
  useEffect(() => { void other(); }, []);
  return <button onClick={unrelatedHandler}>go</button>;
}
`;

describe("negative controls (SC-09 mandated)", () => {
  it("N1 — a module-scope call fails JSX-event mode", () => {
    const result = jsx(N1, "onClick");
    expect(result.wired).toBe(false);
  });

  it("N1 — a module-scope call fails effect mode", () => {
    const result = effect(N1);
    expect(result.wired).toBe(false);
  });

  it("N2 — an unused local callback fails JSX-event mode", () => {
    const result = jsx(N2, "onClick");
    expect(result.wired).toBe(false);
  });

  it("N2 — an unused local callback fails effect mode", () => {
    const result = effect(N2);
    expect(result.wired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Positive fixtures — JSX-event mode
// ---------------------------------------------------------------------------

// P1 — inline arrow bound directly to the attribute.
const P1 = `
import { myBuilder } from "./api.js";
export function View({ id }: { id: string }) {
  return <button onClick={() => myBuilder(id)}>go</button>;
}
`;

// P2 — named handler via useCallback.
const P2 = `
import { myBuilder } from "./api.js";
export function View() {
  const handleClick = useCallback(() => { void myBuilder(); }, []);
  return <button onClick={handleClick}>go</button>;
}
`;

// P3 — module-scope function declaration as the handler.
const P3 = `
import { myBuilder } from "./api.js";
function handleSubmit() { myBuilder(); }
export function View() {
  return <form onSubmit={handleSubmit}><button type="submit">go</button></form>;
}
`;

describe("JSX-event mode positives", () => {
  it("P1 — an inline arrow referencing the identifier is wired", () => {
    const result = jsx(P1, "onClick");
    expect(result.wired).toBe(true);
  });

  it("P2 — a useCallback handler referencing the identifier is wired", () => {
    const result = jsx(P2, "onClick");
    expect(result.wired).toBe(true);
  });

  it("P2 — mode discrimination: an event-bound handler is not an effect", () => {
    const result = effect(P2);
    expect(result.wired).toBe(false);
  });

  it("P3 — a module-scope function handler is wired", () => {
    const result = jsx(P3, "onSubmit");
    expect(result.wired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Positive fixtures — effect mode
// ---------------------------------------------------------------------------

// P4 — zero hop: the builder called directly inside the effect callback.
const P4 = `
import { myBuilder } from "./api.js";
export function View() {
  useEffect(() => { void myBuilder(); }, []);
  return <div>ok</div>;
}
`;

// P5 — one hop, the ReconciliationPanel shape: a component-scope useCallback
// const references the builder, and the effect references the const.
const P5 = `
import { myBuilder } from "./api.js";
export function View() {
  const load = useCallback(async () => { await myBuilder(); }, []);
  useEffect(() => { void load(); }, [load]);
  return <div>ok</div>;
}
`;

// P5b — one hop via a module-scope function declaration.
const P5b = `
import { myBuilder } from "./api.js";
function load() { return myBuilder(); }
export function View() {
  useEffect(() => { void load(); }, []);
  return <div>ok</div>;
}
`;

describe("effect mode positives", () => {
  it("P4 — a direct reference inside the effect callback is wired (zero hops)", () => {
    const result = effect(P4);
    expect(result.wired).toBe(true);
  });

  it("P4 — mode discrimination: an effect-only reference is not JSX-wired", () => {
    const result = jsx(P4, "onClick");
    expect(result.wired).toBe(false);
  });

  it("P5 — the ReconciliationPanel shape (effect -> useCallback const -> builder) is wired (one hop)", () => {
    const result = effect(P5);
    expect(result.wired).toBe(true);
  });

  it("P5b — one hop via a module-scope function is wired", () => {
    const result = effect(P5b);
    expect(result.wired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discrimination sharpeners
// ---------------------------------------------------------------------------

// D1 — two hops: effect calls a, a calls b, b calls myBuilder. Must FAIL —
// "one hop, and one hop only".
const D1 = `
import { myBuilder } from "./api.js";
function b() { return myBuilder(); }
function a() { return b(); }
export function View() {
  useEffect(() => { void a(); }, []);
  return <div>ok</div>;
}
`;

// D3 — property-access non-reference: only `api.myBuilder` (a property NAME,
// never a local identifier use) appears inside the bound handler.
const D3 = `
import { api } from "./api.js";
export function View() {
  const handleClick = () => { void api.myBuilder(); };
  return <button onClick={handleClick}>go</button>;
}
`;

// D4 — unresolvable handler: bound to props.onSave, not a same-module
// declaration or inline function.
const D4 = `
export function View(props: { onSave: () => void }) {
  return <button onClick={props.onSave}>save</button>;
}
`;

describe("discrimination sharpeners", () => {
  it("D1 — two hops fail effect mode (one hop, and one hop only)", () => {
    const result = effect(D1);
    expect(result.wired).toBe(false);
  });

  it("D2 — the wrong attribute on a wired module is not wired", () => {
    const result = jsx(P2, "onChange");
    expect(result.wired).toBe(false);
  });

  it("D3 — a property-access name is not a reference", () => {
    const result = jsx(D3, "onClick");
    expect(result.wired).toBe(false);
  });

  it("D4 — an unresolvable handler is not wired, and detail says so", () => {
    const result = jsx(D4, "onClick", "onSave");
    expect(result.wired).toBe(false);
    expect(result.detail).toContain("unresolvable");
  });
});

// ---------------------------------------------------------------------------
// Robustness — the never-throws contract
// ---------------------------------------------------------------------------

describe("malformed input", () => {
  it("both modes walk whatever tree the parser produced without throwing", () => {
    const mangled = `export function View( { <button onClick={() => myBuilder( }`;
    expect(() => jsx(mangled, "onClick")).not.toThrow();
    expect(() => effect(mangled)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Convenience-wrapper smoke — one fixture written to a temp dir; the wrappers
// must agree with the core functions on it. Deliberately NOT pointed at any
// real src/ui/ component (that is WS-20/WS-18's job).
// ---------------------------------------------------------------------------

describe("convenience wrappers", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("file wrappers agree with the core functions on a temp-dir module", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "wiring-check-"));
    // One module wired in BOTH modes so both wrappers have something to find.
    const sourceText = `
import { myBuilder } from "./api.js";
export function View() {
  const handleClick = useCallback(() => { void myBuilder(); }, []);
  useEffect(() => { void myBuilder(); }, []);
  return <button onClick={handleClick}>go</button>;
}
`;
    const filePath = path.join(tempDir, "fixture.tsx");
    writeFileSync(filePath, sourceText, "utf-8");

    const jsxFromFile = checkJsxEventWiringFile(filePath, "onClick", "myBuilder");
    const jsxFromCore = checkJsxEventWiring({
      fileName: filePath,
      sourceText,
      eventAttribute: "onClick",
      identifier: "myBuilder",
    });
    expect(jsxFromFile.wired).toBe(true);
    expect(jsxFromFile).toEqual(jsxFromCore);

    const effectFromFile = checkEffectWiringFile(filePath, "myBuilder");
    const effectFromCore = checkEffectWiring({
      fileName: filePath,
      sourceText,
      identifier: "myBuilder",
    });
    expect(effectFromFile.wired).toBe(true);
    expect(effectFromFile).toEqual(effectFromCore);
  });
});
