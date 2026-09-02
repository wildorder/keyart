/**
 * WS-19: the two-mode JSX/effect wiring analyzer (SC-09).
 *
 * A purely syntactic TypeScript-compiler-API tool over arbitrary `.tsx`/`.ts`
 * source text. Two modes share one question — "is this identifier *used*
 * inside the resolved scope?" — but differ in where the walk starts:
 *
 * 1. **JSX-event mode** (`checkJsxEventWiring`, Tier A / Tier C): locate a JSX
 *    event attribute, resolve its expression to a handler declared in the same
 *    module (or an inline arrow), and assert the identifier is referenced
 *    INSIDE that resolved declaration — zero hops beyond handler resolution.
 * 2. **Effect mode** (`checkEffectWiring`, Tier B): the entry set is the
 *    module's `useEffect` callbacks; the identifier must be referenced inside
 *    a callback, OR inside a same-module function whose own identifier is
 *    referenced inside a callback — ONE HOP, and one hop only.
 *
 * Placement is load-bearing: this file lives under `src/integration/` so the
 * devDependency `typescript` import is never emitted (`tsconfig.build.json`
 * excludes `src/integration/**`) and `package-contents.test.ts` stays green.
 *
 * The two core functions are pure — no I/O, no `ts.Program`, no type checker,
 * no module resolution — and never throw on malformed input (the compiler
 * API's parser is error-tolerant; whatever tree it produces gets walked).
 */
import ts from "typescript"; // devDependency; never emitted (src/integration/** excluded from build)
import { readFileSync } from "node:fs";

export interface WiringResult {
  /** True iff the mode's discriminating assertion holds for this identifier. */
  wired: boolean;
  /**
   * Human-readable diagnostic: on success, which attribute/handler or which
   * effect (and hop function, if any) matched; on failure, why not (attribute
   * absent, handler unresolvable, identifier never referenced, reference found
   * only at module scope / in an unbound callback / beyond one hop, ...).
   * For test-failure messages only — no consumer branches on its text.
   */
  detail: string;
}

export interface WiringQuery {
  /** Name used for parse positions and diagnostics only — no I/O happens here. */
  fileName: string;
  /** Full source text of the module, parsed as TSX. */
  sourceText: string;
  /** The identifier to find: a request builder or a state setter. */
  identifier: string;
}

export interface JsxEventWiringQuery extends WiringQuery {
  /** JSX event attribute name, e.g. "onClick" | "onChange" | "onSubmit". */
  eventAttribute: string;
}

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

function parse(query: WiringQuery): ts.SourceFile {
  return ts.createSourceFile(
    query.fileName,
    query.sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
}

/** Depth-first walk of every descendant (the node itself included). */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * Is this `Identifier` node a genuine *reference* to the name it spells?
 * Excluded per SC-09's shared rule: property-access names (`obj.x`),
 * non-shorthand property-assignment keys (`{ x: v }` — the shorthand `{ x }`
 * IS a reference), declaration names (function/class/variable/parameter/
 * import/export binding names), and JSX attribute names.
 */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  // The right-hand name of `obj.identifier` is a property name, not a use.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  // `{ identifier: v }` — the key is a property name; `{ identifier }`
  // (ShorthandPropertyAssignment) does not hit this branch and stays a reference.
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  // Declaration names of every binding-introducing form.
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // `<Button identifier={...} />` — an attribute name, not a use.
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  return true;
}

/** True iff `name` is referenced (per `isReference`) anywhere inside `scope`. */
function referencesName(scope: ts.Node, name: string): boolean {
  let found = false;
  walk(scope, (n) => {
    if (!found && ts.isIdentifier(n) && n.text === name && isReference(n)) found = true;
  });
  return found;
}

/** A same-module declaration a handler/hop name can resolve to, by SC-09's rule. */
interface ResolvedDeclaration {
  name: string;
  /** The node searched for references: the function itself, or the initializer. */
  searchNode: ts.Node;
  /** For diagnostics only. */
  kind: string;
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isUseCallbackCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "useCallback";
  // `React.useCallback` (or any property access ending in `.useCallback`).
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "useCallback";
}

/**
 * Collect every declaration in the module — at ANY lexical scope (module
 * scope or inside a component body; the `ReconciliationPanel` shape) — that a
 * handler or hop-function name can resolve to: `function` declarations,
 * arrow/function-expression consts, and `useCallback(fn, deps)` consts
 * (resolved to `fn`; the deps array can only add always-true references).
 */
function collectDeclarations(sourceFile: ts.SourceFile): Map<string, ResolvedDeclaration[]> {
  const byName = new Map<string, ResolvedDeclaration[]>();
  const add = (decl: ResolvedDeclaration): void => {
    const list = byName.get(decl.name);
    if (list === undefined) byName.set(decl.name, [decl]);
    else list.push(decl);
  };
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      add({ name: node.name.text, searchNode: node, kind: "function declaration" });
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (isFunctionLike(init)) {
        add({ name: node.name.text, searchNode: init, kind: "arrow/function expression" });
      } else if (isUseCallbackCall(init)) {
        const fn = init.arguments[0];
        add({
          name: node.name.text,
          searchNode: fn !== undefined && isFunctionLike(fn) ? fn : init,
          kind: "useCallback",
        });
      }
    }
  });
  return byName;
}

// ---------------------------------------------------------------------------
// Mode 1 — JSX-event (Tier A and Tier C)
// ---------------------------------------------------------------------------

/** Mode 1 — Tier A / Tier C: JSX-event origin. Pure; no I/O, no ts.Program. */
export function checkJsxEventWiring(query: JsxEventWiringQuery): WiringResult {
  try {
    const sourceFile = parse(query);
    const declarations = collectDeclarations(sourceFile);

    // Every JsxAttribute named `eventAttribute` (on opening/self-closing
    // elements — the only places JsxAttributes appear).
    const occurrences: ts.JsxAttribute[] = [];
    walk(sourceFile, (node) => {
      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === query.eventAttribute
      ) {
        occurrences.push(node);
      }
    });

    if (occurrences.length === 0) {
      return {
        wired: false,
        detail: `${query.fileName}: no JSX attribute named "${query.eventAttribute}" appears in the module`,
      };
    }

    const failures: string[] = [];
    for (const attr of occurrences) {
      const expr =
        attr.initializer !== undefined && ts.isJsxExpression(attr.initializer)
          ? attr.initializer.expression
          : undefined;
      if (expr === undefined) {
        failures.push(`"${query.eventAttribute}" carries no expression`);
        continue;
      }
      // Inline arrow / function expression: the resolved declaration is the
      // function itself — zero hops means we search only inside it.
      if (isFunctionLike(expr)) {
        if (referencesName(expr, query.identifier)) {
          return {
            wired: true,
            detail: `"${query.identifier}" is referenced inside the inline handler bound to "${query.eventAttribute}"`,
          };
        }
        failures.push(
          `the inline handler bound to "${query.eventAttribute}" never references "${query.identifier}"`,
        );
        continue;
      }
      // An identifier: resolve, by name, to any same-module declaration.
      if (ts.isIdentifier(expr)) {
        const resolved = declarations.get(expr.text);
        if (resolved === undefined || resolved.length === 0) {
          failures.push(
            `"${query.eventAttribute}={${expr.text}}" is unresolvable: no same-module declaration named "${expr.text}"`,
          );
          continue;
        }
        // If several declarations share the name, ANY satisfying one wires it.
        const hit = resolved.find((d) => referencesName(d.searchNode, query.identifier));
        if (hit !== undefined) {
          return {
            wired: true,
            detail: `"${query.identifier}" is referenced inside handler "${hit.name}" (${hit.kind}) bound to "${query.eventAttribute}"`,
          };
        }
        failures.push(
          `handler "${expr.text}" bound to "${query.eventAttribute}" never references "${query.identifier}" inside it (zero hops)`,
        );
        continue;
      }
      // Anything else (props.onX, a call result, ...) is unresolvable.
      failures.push(
        `"${query.eventAttribute}" is bound to an unresolvable expression (${ts.SyntaxKind[expr.kind]}) — not an inline function or a same-module handler identifier`,
      );
    }
    return { wired: false, detail: `${query.fileName}: ${failures.join("; ")}` };
  } catch (err) {
    // The parser is error-tolerant, so this is a belt-and-braces guarantee of
    // the "never throws on malformed input" contract.
    return { wired: false, detail: `${query.fileName}: analyzer error: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Mode 2 — effect (Tier B)
// ---------------------------------------------------------------------------

/** Mode 2 — Tier B: useEffect origin, one-hop rule. Pure; no I/O, no ts.Program. */
export function checkEffectWiring(query: WiringQuery): WiringResult {
  try {
    const sourceFile = parse(query);

    // Effect callbacks: first argument of `useEffect(...)` / `X.useEffect(...)`
    // when that argument is an arrow or function expression. Only `useEffect`
    // — not `useLayoutEffect`, not custom hooks — per the manifest.
    const effectCallbacks: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const isUseEffect =
        (ts.isIdentifier(callee) && callee.text === "useEffect") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "useEffect");
      if (!isUseEffect) return;
      const fn = node.arguments[0];
      if (fn !== undefined && isFunctionLike(fn)) effectCallbacks.push(fn);
    });

    if (effectCallbacks.length === 0) {
      return {
        wired: false,
        detail: `${query.fileName}: the module declares no useEffect callback`,
      };
    }

    // Zero hops: the identifier referenced directly inside any effect callback.
    for (const [index, callback] of effectCallbacks.entries()) {
      if (referencesName(callback, query.identifier)) {
        return {
          wired: true,
          detail: `"${query.identifier}" is referenced directly inside useEffect callback #${index + 1}`,
        };
      }
    }

    // One hop, and one hop only: a same-module function that references the
    // identifier INSIDE it, whose own name is referenced inside an effect
    // callback. A two-link chain (effect -> f -> g -> identifier) fails by
    // construction: f never references the identifier itself, and g's name is
    // never referenced inside the effect.
    const declarations = collectDeclarations(sourceFile);
    for (const [name, resolved] of declarations) {
      const hit = resolved.find((d) => referencesName(d.searchNode, query.identifier));
      if (hit === undefined) continue;
      for (const [index, callback] of effectCallbacks.entries()) {
        if (referencesName(callback, name)) {
          return {
            wired: true,
            detail: `"${query.identifier}" is referenced inside "${name}" (${hit.kind}), whose identifier is referenced inside useEffect callback #${index + 1} (one hop)`,
          };
        }
      }
    }

    return {
      wired: false,
      detail: `${query.fileName}: "${query.identifier}" is not referenced inside any useEffect callback, nor inside any same-module function referenced by one (one hop, and one hop only)`,
    };
  } catch (err) {
    return { wired: false, detail: `${query.fileName}: analyzer error: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers (the only I/O in this module)
// ---------------------------------------------------------------------------

/** Convenience wrapper that reads the module off disk (node:fs, sync) then delegates. */
export function checkJsxEventWiringFile(
  filePath: string,
  eventAttribute: string,
  identifier: string,
): WiringResult {
  const sourceText = readFileSync(filePath, "utf-8");
  return checkJsxEventWiring({ fileName: filePath, sourceText, eventAttribute, identifier });
}

/** Convenience wrapper that reads the module off disk (node:fs, sync) then delegates. */
export function checkEffectWiringFile(filePath: string, identifier: string): WiringResult {
  const sourceText = readFileSync(filePath, "utf-8");
  return checkEffectWiring({ fileName: filePath, sourceText, identifier });
}
