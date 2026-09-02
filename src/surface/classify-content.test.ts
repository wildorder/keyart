import { describe, it, expect } from "vitest";
import {
  classifyObservedElements,
  contentGroupKeyOf,
  CONTENT_GROUP_MIN,
  EXAMPLE_SOURCES_MAX,
  EXAMPLE_SOURCE_MAX_LEN,
} from "./classify-content.js";
import type { ObservedElement } from "./scan.js";

const PAGE_ORIGIN = "http://127.0.0.1:4000";

function structure(
  path = "body>div>svg",
  parentKey = "body[0]",
  siblingIndex = 0,
): ObservedElement["structure"] {
  return { path, parentKey, siblingIndex };
}

function img(
  source: string,
  overrides: Partial<ObservedElement> = {},
): ObservedElement {
  return {
    type: "img",
    source,
    box: { x: 0, y: 0, width: 48, height: 48 },
    visible: true,
    hints: {},
    structure: structure(),
    ...overrides,
  };
}

function svg(source: string, overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    type: "svg",
    source,
    box: { x: 0, y: 0, width: 24, height: 24 },
    visible: true,
    hints: {},
    structure: structure(),
    ...overrides,
  };
}

describe("classifyObservedElements — repetition boundary at 2 vs 3 (Test 1)", () => {
  it("two distinct-source siblings stay kept; a third distinct source fires the group", () => {
    const two = [
      img(`${PAGE_ORIGIN}/a.jpg`, { structure: structure("ul>li>img", "ul[0]", 0) }),
      img(`${PAGE_ORIGIN}/b.jpg`, { structure: structure("ul>li>img", "ul[0]", 1) }),
    ];
    const twoResult = classifyObservedElements(two, { pageOrigin: PAGE_ORIGIN });
    expect(twoResult.kept).toHaveLength(2);
    expect(twoResult.groups).toHaveLength(0);

    const three = [
      ...two,
      img(`${PAGE_ORIGIN}/c.jpg`, { structure: structure("ul>li>img", "ul[0]", 2) }),
    ];
    const threeResult = classifyObservedElements(three, { pageOrigin: PAGE_ORIGIN });
    expect(threeResult.kept).toHaveLength(0);
    expect(threeResult.groups).toHaveLength(1);
    expect(threeResult.groups[0].reason).toBe("repeated-content");
    expect(threeResult.groups[0].count).toBe(3);
    expect(CONTENT_GROUP_MIN).toBe(3);
  });
});

describe("classifyObservedElements — identical sources are chrome, not repetition (Test 2)", () => {
  it("five siblings sharing the SAME source stay kept — distinct sources are what fires", () => {
    const elements = Array.from({ length: 5 }, (_, i) =>
      img(`${PAGE_ORIGIN}/logo.svg`, { structure: structure("nav>img", "nav[0]", i) }),
    );
    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.kept).toHaveLength(5);
    expect(result.groups).toHaveLength(0);
  });
});

describe("classifyObservedElements — structure grouping separates lists (Test 3)", () => {
  it("two same-shaped lists at different positions form two distinct groups", () => {
    const listA = [0, 1, 2].map((i) =>
      img(`${PAGE_ORIGIN}/a${i}.jpg`, { structure: structure("ul.grid>li>img", "ul.grid[0]", i) }),
    );
    const listB = [0, 1, 2].map((i) =>
      img(`${PAGE_ORIGIN}/b${i}.jpg`, { structure: structure("ul.grid>li>img", "ul.grid[3]", i) }),
    );
    const result = classifyObservedElements([...listA, ...listB], { pageOrigin: PAGE_ORIGIN });
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((g) => g.count === 3)).toBe(true);
    expect(new Set(result.groups.map((g) => g.key)).size).toBe(2);
  });
});

describe("classifyObservedElements — foreign host fires regardless of repetition (Test 4)", () => {
  it("a single foreign-host img is skipped as foreign-origin", () => {
    const elements = [img("https://cdn.other.example/x.jpg")];
    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe("foreign-origin");
    expect(result.groups[0].count).toBe(1);
  });
});

describe("classifyObservedElements — same-origin upload paths fire; static paths do not (Test 5)", () => {
  it("distinguishes /uploads/ from /static/media/", () => {
    const uploadImg = img(`${PAGE_ORIGIN}/uploads/vendor/9.jpg`);
    const staticImg = img(`${PAGE_ORIGIN}/static/media/logo.a1b2.svg`);
    const result = classifyObservedElements([uploadImg, staticImg], { pageOrigin: PAGE_ORIGIN });
    expect(result.kept.map((e) => e.source)).toEqual([staticImg.source]);
    const group = result.groups.find((g) => g.reason === "foreign-origin");
    expect(group?.count).toBe(1);
  });
});

describe("classifyObservedElements — contentOrigins extends the signal three ways (Test 6)", () => {
  it("exact host, dot-suffix host, and path substring all fire as foreign-origin", () => {
    const exactHost = img("http://assets.partner.test/a.jpg");
    const dotSuffix = img("http://cdn.vendorcdn.test/b.jpg");
    const pathSubstring = img(`${PAGE_ORIGIN}/gallery/c.jpg`);
    const result = classifyObservedElements([exactHost, dotSuffix, pathSubstring], {
      pageOrigin: PAGE_ORIGIN,
      contentOrigins: ["assets.partner.test", ".vendorcdn.test", "/gallery/"],
    });
    const total = result.groups
      .filter((g) => g.reason === "foreign-origin")
      .reduce((sum, g) => sum + g.count, 0);
    expect(total).toBe(3);
  });
});

describe("classifyObservedElements — inline svg is never origin-classified (Test 7)", () => {
  it("markup containing a foreign URL string stays kept", () => {
    const elements = [svg('<svg><image href="https://cdn.other/x"/></svg>')];
    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.kept).toHaveLength(1);
  });
});

describe("classifyObservedElements — data:/blob:/unparseable sources stay chrome (Test 8)", () => {
  it("none of the three fire a group", () => {
    const elements = [
      img("data:image/png;base64,AAAA", { structure: structure("div>img", "div[0]", 0) }),
      img("blob:http://127.0.0.1:4000/abc-def", { structure: structure("div>img", "div[1]", 0) }),
      img("not a url at all", { structure: structure("div>img", "div[2]", 0) }),
    ];
    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.groups).toHaveLength(0);
    expect(result.kept).toHaveLength(3);
  });
});

describe("classifyObservedElements — ignore marks are consumed, never re-matched (Test 9)", () => {
  it("marked-and-configured elements skip; a stale mark keeps", () => {
    const marked1 = img(`${PAGE_ORIGIN}/promo1.jpg`, { ignoredBy: ".promo" });
    const marked2 = img(`${PAGE_ORIGIN}/promo2.jpg`, { ignoredBy: ".promo" });
    const stale = img(`${PAGE_ORIGIN}/stale.jpg`, { ignoredBy: ".stale" });
    const result = classifyObservedElements([marked1, marked2, stale], {
      pageOrigin: PAGE_ORIGIN,
      ignore: [".promo"],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe("ignored-selector");
    expect(result.groups[0].key).toContain(".promo");
    expect(result.kept.some((e) => e.source === stale.source)).toBe(true);
  });
});

describe("classifyObservedElements — precedence and no double counting (Test 10)", () => {
  it("simultaneously repeated + foreign + ignored elements form exactly one ignored-selector group", () => {
    const elements = [0, 1, 2].map((i) =>
      img(`https://cdn.other.example/x${i}.jpg`, {
        structure: structure("ul>li>img", "ul[0]", i),
        ignoredBy: ".grid",
      }),
    );
    const result = classifyObservedElements(elements, {
      pageOrigin: PAGE_ORIGIN,
      ignore: [".grid"],
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].reason).toBe("ignored-selector");
    expect(result.groups[0].count).toBe(3);
    const totalGroupCount = result.groups.reduce((sum, g) => sum + g.count, 0);
    expect(totalGroupCount).toBe(elements.length - result.kept.length);
  });
});

describe("classifyObservedElements — group shape is exactly the contract (Test 11)", () => {
  it("has only the five contract fields, capped/truncated example sources, and first-non-empty hints", () => {
    const longSource = `${PAGE_ORIGIN}/` + "x".repeat(200) + ".jpg";
    const members: ObservedElement[] = [
      img(`${PAGE_ORIGIN}/0.jpg`, { structure: structure("ul>li>img", "ul[0]", 0), hints: {} }),
      img(`${PAGE_ORIGIN}/1.jpg`, {
        structure: structure("ul>li>img", "ul[0]", 1),
        hints: { classNames: ["card-photo"], nearbyText: "Nearby" },
      }),
      img(`${PAGE_ORIGIN}/2.jpg`, { structure: structure("ul>li>img", "ul[0]", 2) }),
      img(`${PAGE_ORIGIN}/3.jpg`, { structure: structure("ul>li>img", "ul[0]", 3) }),
      img(longSource, { structure: structure("ul>li>img", "ul[0]", 4) }),
    ];
    const result = classifyObservedElements(members, { pageOrigin: PAGE_ORIGIN });
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(Object.keys(group).sort()).toEqual(
      ["count", "exampleSources", "hints", "key", "reason"].sort(),
    );
    expect(group.exampleSources).toHaveLength(EXAMPLE_SOURCES_MAX);
    for (const src of group.exampleSources) {
      expect(src.length).toBeLessThanOrEqual(EXAMPLE_SOURCE_MAX_LEN);
    }
    expect(group.exampleSources).toEqual([
      `${PAGE_ORIGIN}/0.jpg`,
      `${PAGE_ORIGIN}/1.jpg`,
      `${PAGE_ORIGIN}/2.jpg`,
    ]);
    expect(group.hints).toEqual({ classNames: ["card-photo"], nearbyText: "Nearby" });
  });
});

describe("classifyObservedElements — determinism (Test 12)", () => {
  it("two calls on the same input deep-equal, including array order", () => {
    const elements = [0, 1, 2].map((i) =>
      img(`${PAGE_ORIGIN}/${i}.jpg`, { structure: structure("ul>li>img", "ul[0]", i) }),
    );
    const opts = { pageOrigin: PAGE_ORIGIN };
    const first = classifyObservedElements(elements, opts);
    const second = classifyObservedElements(elements, opts);
    expect(first).toEqual(second);
    expect(first.skipped).toEqual(first.groups);
  });
});

describe("classifyObservedElements — purity and identity preservation (Test 13)", () => {
  it("kept elements are reference-identical to the input; the input is unmutated", () => {
    const chrome = img(`${PAGE_ORIGIN}/icon.svg`);
    const repeated = [0, 1, 2].map((i) =>
      img(`${PAGE_ORIGIN}/photo${i}.jpg`, { structure: structure("ul>li>img", "ul[0]", i) }),
    );
    const elements = [chrome, ...repeated];
    const snapshot = JSON.parse(JSON.stringify(elements)) as ObservedElement[];

    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.kept[0]).toBe(chrome);
    expect(elements).toEqual(snapshot);
  });
});

describe("classifyObservedElements — a missing structure keeps the element (Test 14)", () => {
  it("an element with no structure field is kept, never skipped, no throw", () => {
    const { structure: _structure, ...withoutStructure } = img(`${PAGE_ORIGIN}/x.jpg`);
    const elements = [withoutStructure as ObservedElement];
    expect(() =>
      classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN }),
    ).not.toThrow();
    const result = classifyObservedElements(elements, { pageOrigin: PAGE_ORIGIN });
    expect(result.kept).toHaveLength(1);
  });
});

describe("contentGroupKeyOf (used by scan.ts Test 15 too)", () => {
  it("is a helper visible from classify-content.js", () => {
    const el = img(`${PAGE_ORIGIN}/x.jpg`, { structure: structure("a>b", "a[0]", 4) });
    expect(contentGroupKeyOf(el)).toBe("img|a>b|a[0]");
  });
});
