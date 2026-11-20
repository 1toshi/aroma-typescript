import { describe, expect, it } from "vitest";

import {
  featurize,
  parentFeature,
  positionContext,
  siblingFeature,
  tokenContext,
  tokenFeature,
  usageFeature,
  VAR,
} from "../src/features.ts";
import {
  buildIndex,
  queryFromSnippet,
  recommend,
  search,
  type AromaIndex,
  type Query,
} from "../src/index.ts";
import { prune, type TokenTable } from "../src/prune.ts";
import { label, type Tree } from "../src/tree.ts";
import { toy } from "./toy.ts";

// The paper is "Aroma: Code Recommendation via Structural Code Search"
// (arXiv:1812.01158v4). Section, figure, table, and listing numbers are its.

const snippet = (source: string) => toy.parseSnippet(source)!;
const featuresOf = (source: string) =>
  featurize(snippet(source))
    .flatMap((entry) => entry.features)
    .sort();

/** Figure 4: the simplified parse tree of Listing 4. */
const LISTING_4 = `
[ if [ ( [ $view instanceof ViewGroup ] ) ]
  [ { [ for ( [ [ int [ $i = 0 ] ] ; [ $i < [ [ ( [ ( ViewGroup ) $view ] ) ] . [ getChildCount ( ) ] ] ] ; [ $i ++ ] ] )
        [ { [ [ View [ $innerView = [ [ ( [ ( ViewGroup ) $view ] ) ] . [ getChildAt ( $i ) ] ] ] ] ; ] } ] ] } ] ]
`;

describe("simplified parse tree labels (Section 3.1)", () => {
  it("keeps keyword tokens and writes # for other tokens and subtrees", () => {
    expect(label(snippet("[ x > [ y . f ] ]") as Tree)).toBe("#>#");
    expect(label(snippet(LISTING_4) as Tree)).toBe("if##");
  });
});

describe("featurize (Section 3.2)", () => {
  it("extracts Table 2's features for view_30 and 0_20 in Figure 4", () => {
    const tokens = featurize(snippet(LISTING_4));
    expect(tokens.map((entry) => entry.token.text)).toEqual([
      "view",
      "ViewGroup",
      "i",
      "0",
      "i",
      "ViewGroup",
      "view",
      "getChildCount",
      "i",
      "View",
      "innerView",
      "ViewGroup",
      "view",
      "getChildAt",
      "i",
    ]);
    // Table 2 prints the for-control label as "#;#;#;"; Figure 4 draws it as "#;#;#".
    expect([...tokens[3]!.features].sort()).toEqual(
      [
        tokenFeature("0"),
        parentFeature("0", 2, "#=#"),
        parentFeature("0", 1, "int#"),
        parentFeature("0", 1, "#;#;#"),
        siblingFeature(VAR, "0"),
        siblingFeature("0", VAR),
      ].sort(),
    );
    expect([...tokens[6]!.features].sort()).toEqual(
      [
        tokenFeature(VAR),
        parentFeature(VAR, 2, "(#)#"),
        parentFeature(VAR, 1, "(#)"),
        parentFeature(VAR, 1, "#.#"),
        siblingFeature("ViewGroup", VAR),
        siblingFeature(VAR, "getChildCount"),
        usageFeature(positionContext(1, "#instanceof#"), positionContext(2, "(#)#")),
        usageFeature(positionContext(2, "(#)#"), positionContext(2, "(#)#")),
      ].sort(),
    );
  });

  it("relates consecutive uses of one variable by their contexts", () => {
    // `if (y < 0) x = -x;`: x is used as (1, #=#) and then as (1, -#); each
    // use records the pair, and y, used once, records none.
    const source = "[ if [ ( [ $y < 0 ] ) ] [ [ $x = [ - $x ] ] ; ] ]";
    const pair = usageFeature(positionContext(1, "#=#"), positionContext(1, "-#"));
    expect(featuresOf(source).filter((feature) => feature === pair)).toHaveLength(2);
    expect([...featurize(snippet(source))[0]!.features].sort()).toEqual(
      [
        tokenFeature(VAR),
        parentFeature(VAR, 1, "#<#"),
        parentFeature(VAR, 1, "(#)"),
        parentFeature(VAR, 1, "if##"),
        siblingFeature(VAR, "0"),
      ].sort(),
    );
  });

  it("uses the member name as the context of a variable in a member access", () => {
    // `x.foo(); x.bar();`: the context of x is foo, then bar, not (1, #.#).
    const features = featuresOf("[ [ $x . [ foo ( ) ] ] ; ] [ [ $x . [ bar ( ) ] ] ; ]");
    expect(features).toContain(usageFeature(tokenContext("foo"), tokenContext("bar")));
    expect(features).not.toContain(
      usageFeature(positionContext(1, "#.#"), positionContext(1, "#.#")),
    );
  });

  it("is unchanged by renaming local variables, and changed by renaming anything else", () => {
    const original = featuresOf("[ [ $a = [ load ( $b ) ] ] ; ] [ [ save ( $a ) ] ; ]");
    const renamed = featuresOf("[ [ $out = [ load ( $src ) ] ] ; ] [ [ save ( $out ) ] ; ]");
    const otherCall = featuresOf("[ [ $a = [ fetch ( $b ) ] ] ; ] [ [ save ( $a ) ] ; ]");
    const otherFlow = featuresOf("[ [ $a = [ load ( $b ) ] ] ; ] [ [ save ( $b ) ] ; ]");
    expect(renamed).toEqual(original);
    expect(otherCall).not.toEqual(original);
    expect(otherFlow).not.toEqual(original);
  });

  it("tells `if (x > 0) z = 3;` from `if (z > 3) x = 0;`", () => {
    const first = featuresOf("[ if [ ( [ $x > 0 ] ) ] [ [ $z = 3 ] ; ] ]");
    const second = featuresOf("[ if [ ( [ $z > 3 ] ) ] [ [ $x = 0 ] ; ] ]");
    expect(first).toContain(parentFeature("3", 2, "if##"));
    expect(first).toContain(parentFeature("3", 2, "#=#"));
    expect(second).not.toContain(parentFeature("3", 2, "if##"));
    expect(second).not.toEqual(first);
  });
});

/** Algorithm 1 as written: rescan every remaining token for the best gain at each step. */
function naivePrune(target: Map<number, number>, table: TokenTable, candidates: number[]) {
  const featuresOfToken = (token: number) =>
    Array.from(table.features.subarray(table.offsets[token]!, table.offsets[token + 1]!));
  const score = (tokens: number[]) => {
    const have = new Map<number, number>();
    for (const feature of tokens.flatMap(featuresOfToken)) {
      have.set(feature, (have.get(feature) ?? 0) + 1);
    }
    let total = 0;
    for (const [feature, count] of have) {
      total += Math.min(count, target.get(feature) ?? 0);
    }
    return total;
  };
  const kept: number[] = [];
  for (;;) {
    let best: number | undefined;
    let bestScore = score(kept);
    for (const token of candidates) {
      if (!kept.includes(token) && score([...kept, token]) > bestScore) {
        best = token;
        bestScore = score([...kept, token]);
      }
    }
    if (best === undefined) {
      return { tokens: kept.sort((a, b) => a - b), score: bestScore };
    }
    kept.push(best);
  }
}

function table(tokens: number[][]): TokenTable {
  const offsets = new Uint32Array(tokens.length + 1);
  tokens.forEach((features, index) => {
    offsets[index + 1] = offsets[index]! + features.length;
  });
  return { features: Int32Array.from(tokens.flat()), offsets };
}

function random(seed: number) {
  let state = seed;
  return (bound: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % bound;
  };
}

describe("prune (Algorithm 1)", () => {
  it("keeps no more tokens for a feature than the target has of it", () => {
    const tokens = table([[7], [7], [7, 8]]);
    expect(
      prune(
        new Map([
          [7, 1],
          [8, 1],
        ]),
        tokens,
      ),
    ).toEqual({ tokens: [2], score: 2 });
    expect(
      prune(
        new Map([
          [7, 2],
          [8, 1],
        ]),
        tokens,
      ),
    ).toEqual({ tokens: [0, 2], score: 3 });
  });

  it("keeps every token when the target is the snippet itself", () => {
    const tokens = table([[1, 2, 2], [3], [1, 4]]);
    const target = new Map([
      [1, 2],
      [2, 2],
      [3, 1],
      [4, 1],
    ]);
    expect(prune(target, tokens)).toEqual({ tokens: [0, 1, 2], score: 6 });
  });

  it("picks the same tokens as rescanning for the best token at every step", () => {
    const next = random(20181201);
    for (let round = 0; round < 300; round += 1) {
      const alphabet = 1 + next(12);
      const tokens = Array.from({ length: 1 + next(30) }, () =>
        Array.from({ length: 1 + next(6) }, () => next(alphabet)),
      );
      const target = new Map<number, number>();
      for (let feature = 0; feature < alphabet; feature += 1) {
        const count = next(4);
        if (count > 0) {
          target.set(feature, count);
        }
      }
      const all = tokens.map((_, index) => index);
      const candidates = round % 3 === 0 ? all.filter(() => next(2) === 0) : all;
      expect(prune(target, table(tokens), candidates)).toEqual(
        naivePrune(target, table(tokens), candidates),
      );
    }
  });
});

const method = (name: string, ...statements: string[]) => ({
  path: `${name}.toy`,
  source: ["method " + name, ...statements, "end"].join("\n"),
});
const call = (name: string) => `[ [ ${name} ( ) ] ; ]`;
const calls = (name: string, ...names: string[]) => method(name, ...names.map(call));
const toyIndex = (...files: { path: string; source: string }[]) =>
  buildIndex(files, { languages: [toy] });
const toyQuery = (index: AromaIndex, ...statements: string[]): Query =>
  queryFromSnippet(index, statements.join("\n"), { language: "toy" })!;
const names = (methods: { name: string }[]) => methods.map((entry) => entry.name);

describe("search (Sections 3.3.1 and 3.3.2)", () => {
  it("prunes `y = 2; z = 3;` to `y = 2;` against `x = 1; y = 2;`", () => {
    const index = toyIndex(method("m2", "[ [ y = 2 ] ; ]", "[ [ z = 3 ] ; ]"));
    const [result] = search(index, toyQuery(index, "[ [ x = 1 ] ; ]", "[ [ y = 2 ] ; ]"));
    expect(result!.matchedLines).toEqual([2]);
  });

  it("keeps both `if`s when their nesting is swapped, where a common subsequence drops one", () => {
    const index = toyIndex(
      method(
        "m2",
        "[ if [ ( [ z < 0 ] ) ]",
        "[ if [ ( [ y > 1 ] ) ]",
        "[ [ w = 4 ] ; ] ] ]",
        "[ [ v = 10 ] ; ]",
      ),
    );
    const query = toyQuery(
      index,
      "[ [ x = 1 ] ; ]",
      "[ if [ ( [ y > 1 ] ) ] [ if [ ( [ z < 0 ] ) ] [ [ w = 4 ] ; ] ] ]",
    );
    expect(search(index, query)[0]!.matchedLines).toEqual([2, 3, 4]);
  });

  it("scores a method by the share of the query's features its pruned snippet has", () => {
    // The query has 10 features, 5 per token. `full` matches 4 of each token's
    // (all but the one naming the root, which has three statements, not two);
    // `half` matches 3 of a's (no (a, b) sibling pair) and none of b's.
    const index = toyIndex(calls("half", "a", "d", "e"), calls("full", "a", "b", "c"));
    const results = search(index, toyQuery(index, call("a"), call("b")));
    expect(names(results.map((result) => result.method))).toEqual(["full", "half"]);
    expect(results[0]!.similarity).toBeCloseTo(0.8, 10);
    expect(results[1]!.similarity).toBeCloseTo(0.3, 10);
    expect(search(index, toyQuery(index, call("a"), call("b")), { minSimilarity: 0.65 })).toEqual([
      results[0],
    ]);
  });

  it("counts a feature once in the first phase, however often a method repeats it", () => {
    const index = toyIndex(
      calls("repeats", ...Array.from({ length: 10 }, () => "a")),
      calls("both", "a", "b"),
    );
    const results = search(index, toyQuery(index, call("a"), call("b")), { searchLimit: 1 });
    expect(names(results.map((result) => result.method))).toEqual(["both"]);
  });

  it("reranks by how much of the query a method contains, repeats included", () => {
    // `pair` has more of the query's distinct features (7 against 4), so the
    // first phase puts it first. `triple` has more of its features once
    // repeats count (13 against 8 of 22), so reranking puts it first.
    const index = toyIndex(calls("pair", "a", "b"), calls("triple", "a", "a", "a"));
    const query = toyQuery(index, call("a"), call("a"), call("a"), call("b"));
    const results = search(index, query);
    expect(names(results.map((result) => result.method))).toEqual(["triple", "pair"]);
    expect(results.map((result) => result.similarity * 22)).toEqual([13, 8]);
    expect(names(search(index, query, { searchLimit: 1 }).map((result) => result.method))).toEqual([
      "pair",
    ]);
  });

  it("leaves out methods the caller excludes, and other languages' methods", () => {
    const index = buildIndex(
      [calls("one", "a", "b"), calls("two", "a", "b", "c"), { path: "notes.txt", source: "a b" }],
      { languages: [toy] },
    );
    const query = toyQuery(index, call("a"), call("b"));
    expect(
      names(
        search(index, query, { exclude: (candidate) => candidate.name === "one" }).map(
          (result) => result.method,
        ),
      ),
    ).toEqual(["two"]);
    expect(search(index, { ...query, language: "other" })).toEqual([]);
    expect(index.stats).toMatchObject({ files: 2, methods: 2, unsupportedFiles: 1 });
  });

  it("indexes methods with the same tokens once", () => {
    const index = toyIndex(calls("first", "a", "b"), calls("copy", "a", "b"), calls("c", "a"));
    expect(names([...index.methods])).toEqual(["first", "c"]);
    expect(index.stats).toMatchObject({ methods: 2, duplicateMethods: 1 });
  });
});

describe("recommend (Section 3.3.3)", () => {
  // Two families contain the query `open(); read();`. One goes on to flush and
  // close, the other to log and retry, and every method ends with a call of
  // its own. Hand-computed for the query and X1: |F(q)| = 10; similarity 0.8;
  // |F(X1)| = 28; |F(Prune(F(q), X1))| = 11. Adding X2: cs = 22, csq = 11, so
  // l = 2 and s = 1. Adding Y1 instead: cs = 10, csq = 10, so l = 1 < 1.5.
  const family = (prefix: string, ...shared: string[]) =>
    [1, 2, 3].map((number) =>
      calls(`${prefix}${number}`, "open", "read", ...shared, `${prefix}${number}_only`),
    );
  const [x1, x2, x3] = family("x", "flush", "close");
  const [y1, y2, y3] = family("y", "log", "retry");
  const families = toyIndex(x1!, y1!, x2!, y2!, x3!, y3!);
  const openRead = toyQuery(families, call("open"), call("read"));

  it("recommends one snippet per family, cut down to what its methods share", () => {
    // By default a recommendation needs two methods behind it.
    const recommendations = recommend(families, openRead);
    expect(recommendations.map((entry) => names(entry.members))).toEqual([
      ["x1", "x2", "x3"],
      ["y1", "y2", "y3"],
    ]);
    const [first, second] = recommendations;
    expect(first!.method).toMatchObject({ path: "x1.toy", name: "x1", startLine: 2, endLine: 6 });
    expect(first!.similarity).toBeCloseTo(0.8, 10);
    expect(first!.lines).toEqual([
      { line: 2, text: call("open"), role: "query" },
      { line: 3, text: call("read"), role: "query" },
      { line: 4, text: call("flush"), role: "added" },
      { line: 5, text: call("close"), role: "added" },
    ]);
    expect(first!.code).toBe([call("open"), call("read"), call("flush"), call("close")].join("\n"));
    expect(second!.lines.map((line) => line.text)).toEqual(
      ["open", "read", "log", "retry"].map(call),
    );
  });

  it("drops clusters that mostly repeat an earlier one, leaving the last members on their own", () => {
    // (x2, x3) and (y2, y3) overlap the first two clusters by 2/3. (x3) alone
    // overlaps (x2, x3) by exactly 1/2, which is not more than 0.5.
    const recommendations = recommend(families, openRead, { minSupport: 1 });
    expect(recommendations.map((entry) => names(entry.members))).toEqual([
      ["x1", "x2", "x3"],
      ["y1", "y2", "y3"],
      ["x3"],
      ["y3"],
    ]);
    expect(
      recommend(families, openRead, { limit: 1 }).map((entry) => names(entry.members)),
    ).toEqual([["x1", "x2", "x3"]]);
  });

  it("recommends an unclustered method's whole body when asked to (Section 4.3.5)", () => {
    const index = toyIndex(calls("only", "open", "read", "flush", "close"));
    const query = toyQuery(index, call("open"), call("read"));
    expect(recommend(index, query)).toEqual([]);
    const [recommendation, ...rest] = recommend(index, query, { minSupport: 1 });
    expect(rest).toEqual([]);
    expect(names(recommendation!.members)).toEqual(["only"]);
    expect(recommendation!.lines.map((line) => line.role)).toEqual([
      "query",
      "query",
      "added",
      "added",
    ]);
  });

  it("recommends nothing from methods that add too little to the query", () => {
    // |F(same)| / |F(pruned)| = 1 and |F(one_more)| / |F(pruned)| = 16 / 11.
    const index = toyIndex(calls("same", "open", "read"), calls("one_more", "open", "read", "x"));
    const query = toyQuery(index, call("open"), call("read"));
    expect(recommend(index, query, { minSupport: 1 })).toEqual([]);
    expect(
      recommend(index, query, { minSupport: 1, minExpansion: 1.4 }).map((entry) =>
        names(entry.members),
      ),
    ).toEqual([["one_more"]]);
  });

  it("does not cluster methods that contain different parts of the query", () => {
    // m1 has a, b, c of the query and m2 has b, c, d. They share 24 features,
    // 3 times the 8 their query-like parts share, but those 8 are under half
    // of the 17 in m1's query-like part.
    const index = toyIndex(
      calls("m1", "a", "b", "c", "x", "y", "z"),
      calls("m2", "b", "c", "d", "x", "y", "z"),
    );
    const query = toyQuery(index, call("a"), call("b"), call("c"), call("d"));
    const recommendations = recommend(index, query, { minSimilarity: 0.3, minSupport: 1 });
    expect(recommendations.map((entry) => names(entry.members))).toEqual([["m1"], ["m2"]]);
    expect(recommend(index, query, { minSimilarity: 0.3 })).toEqual([]);
    expect(
      recommend(index, query, { minSimilarity: 0.3, minCohesion: 0.4 }).map((entry) =>
        names(entry.members),
      ),
    ).toEqual([["m1", "m2"]]);
  });

  it("keeps the query's code in a recommendation even where the cluster does not share it", () => {
    // `partial` lacks `c();`, so intersecting `whole` with it alone would drop
    // that line; the thresholds are lowered to let the two cluster at all.
    const index = toyIndex(
      calls("whole", "a", "b", "c", "x", "y", "z", "w"),
      calls("partial", "a", "b", "x", "y", "z", "w"),
    );
    const query = toyQuery(index, call("a"), call("b"), call("c"));
    const [recommendation] = recommend(index, query, { minSimilarity: 0.4, minCohesion: 0.4 });
    expect(names(recommendation!.members)).toEqual(["whole", "partial"]);
    expect(recommendation!.lines.map((line) => [line.text, line.role])).toEqual([
      [call("a"), "query"],
      [call("b"), "query"],
      [call("c"), "query"],
      [call("x"), "added"],
      [call("y"), "added"],
      [call("z"), "added"],
      [call("w"), "added"],
    ]);
  });

  it("recommends nothing below the similarity threshold", () => {
    const index = toyIndex(calls("far", "a", "x", "y", "z", "w"));
    expect(recommend(index, toyQuery(index, call("a"), call("b")), { minSupport: 1 })).toEqual([]);
  });
});
