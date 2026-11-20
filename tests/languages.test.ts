import { describe, expect, it } from "vitest";

import {
  buildIndex,
  queriesFromLines,
  queryFromSnippet,
  recommend,
  search,
  type Query,
  type SourceFile,
} from "../src/index.ts";
import type { Language } from "../src/language.ts";
import { python } from "../src/languages/python.ts";
import { typescript } from "../src/languages/typescript.ts";
import { label, type Node, type Token } from "../src/tree.ts";

const file = (path: string, lines: string[]): SourceFile => ({ path, source: lines.join("\n") });
const lineCount = (source: SourceFile) => source.source.split("\n").length;
const allLines = (source: SourceFile) =>
  Array.from({ length: lineCount(source) }, (_, index) => index + 1);

function tokens(node: Node): Token[] {
  return node.kind === "token" ? [node] : node.children.flatMap(tokens);
}
function labels(node: Node): string[] {
  return node.kind === "token" ? [] : [label(node), ...node.children.flatMap(labels)];
}
const names = (node: Node, local: boolean) => [
  ...new Set(
    tokens(node)
      .filter((token) => !token.keyword && token.local === local)
      .map((token) => token.text),
  ),
];
const methodsOf = (language: Language, source: SourceFile) =>
  language.parseMethods(source.source, source.path);
const withoutOrigin = (query: Query): Query => ({
  language: query.language,
  features: query.features,
  size: query.size,
});

const PYTHON_MODULE = file("store.py", [
  "import json",
  "",
  "def top(path, limit=10):",
  '    """Load rows."""',
  "    rows = []",
  "    def keep(row):",
  '        return row["n"] < limit',
  "    with open(path) as handle:",
  "        for line in handle:  # one row per line",
  "            rows.append(json.loads(line))",
  "    return [row for row in rows if keep(row)]",
  "",
  "class Store:",
  "    size = 0",
  "    async def put(self, key, value):",
  "        self.items[key] = value if value else None",
  "    @staticmethod",
  "    def make():",
  "        return Store()",
  "squares = lambda n: n * n",
]);

const TYPESCRIPT_MODULE = file("store.ts", [
  'import { parse } from "./parse.ts";',
  "",
  "export function plain(input: string, limit = 10): number[] {",
  "  // Parse, then keep the small ones.",
  "  const values = parse(input);",
  "  return values.filter((value) => value < limit);",
  "}",
  "",
  "export const useThing = async (id: string) => {",
  "  const response = await fetch(`/things/${id}`);",
  "  return response?.ok ? response.json() : null;",
  "};",
  "",
  "class Cache<T> {",
  "  private items = new Map<string, T>();",
  "  get(key: string): T | undefined {",
  "    return this.items.get(key);",
  "  }",
  "  clear = () => {",
  "    this.items.clear();",
  "  };",
  "}",
  "",
  "const handlers = {",
  "  onError(error: Error) {",
  "    console.error(error instanceof TypeError, error.message);",
  "  },",
  "};",
]);

describe("python front end", () => {
  const methods = methodsOf(python, PYTHON_MODULE);

  it("finds outermost functions and class methods, and nothing at module level", () => {
    expect(methods.map(({ name, startLine, endLine }) => ({ name, startLine, endLine }))).toEqual([
      { name: "top", startLine: 3, endLine: 11 },
      { name: "Store.put", startLine: 15, endLine: 16 },
      { name: "Store.make", startLine: 18, endLine: 19 },
    ]);
  });

  it("marks names bound in the method as local and leaves imports, calls, and members alone", () => {
    const top = methods[0]!.body;
    expect(names(top, true).sort()).toEqual(
      ["handle", "keep", "limit", "line", "path", "row", "rows"].sort(),
    );
    expect(names(top, false).sort()).toEqual(['"n"', "append", "json", "loads", "open"].sort());
  });

  it("drops comments and docstrings and keeps literals", () => {
    const text = tokens(methods[0]!.body).map((token) => token.text);
    expect(text.join(" ")).not.toMatch(/Load rows|one row per line/);
    expect(names(methods[1]!.body, false).sort()).toEqual(["None", "items"]);
  });

  it("labels trees with their keywords and punctuation", () => {
    expect(labels(methods[1]!.body)).toEqual(
      expect.arrayContaining(["#=#", "#.#", "#[#]", "#if#else#"]),
    );
    expect(tokens(methods[0]!.body).find((token) => token.text === "loads")).toMatchObject({
      line: 10,
      endLine: 10,
      keyword: false,
    });
  });
});

describe("typescript front end", () => {
  const methods = methodsOf(typescript, TYPESCRIPT_MODULE);

  it("finds functions, arrow functions, and methods, named by what they are bound to", () => {
    expect(methods.map(({ name, startLine, endLine }) => ({ name, startLine, endLine }))).toEqual([
      { name: "plain", startLine: 3, endLine: 7 },
      { name: "useThing", startLine: 9, endLine: 12 },
      { name: "Cache.get", startLine: 16, endLine: 18 },
      { name: "Cache.clear", startLine: 19, endLine: 21 },
      { name: "handlers.onError", startLine: 25, endLine: 27 },
    ]);
  });

  it("marks declared names as local and leaves imports, members, and types alone", () => {
    expect(names(methods[0]!.body, true).sort()).toEqual(["input", "limit", "value", "values"]);
    expect(names(methods[0]!.body, false).sort()).toEqual(["filter", "parse"]);
    // In `console.error(error instanceof TypeError, error.message)` the
    // parameter `error` is local and the member `.error` is not.
    expect(names(methods[4]!.body, true)).toEqual(["error"]);
    expect(names(methods[4]!.body, false).sort()).toEqual(
      ["TypeError", "console", "error", "message"].sort(),
    );
  });

  it("drops comments, and labels trees with their keywords and punctuation", () => {
    expect(
      tokens(methods[0]!.body)
        .map((token) => token.text)
        .join(" "),
    ).not.toMatch(/keep the small ones/);
    expect(labels(methods[1]!.body)).toEqual(expect.arrayContaining(["#?.#", "#?#:#", "await#"]));
    expect(labels(methods[4]!.body)).toContain("#instanceof#");
  });

  it("parses JSX in .tsx files", () => {
    const component = file("Banner.tsx", [
      "export function Banner({ title }: Props) {",
      "  const [open, setOpen] = useState(true);",
      "  return open ? <Alert onClose={() => setOpen(false)}>{title}</Alert> : null;",
      "}",
    ]);
    const [banner] = methodsOf(typescript, component);
    expect(banner).toMatchObject({ name: "Banner", startLine: 1, endLine: 4 });
    expect(names(banner!.body, true).sort()).toEqual(["open", "setOpen", "title"]);
    expect(names(banner!.body, false)).toEqual(
      expect.arrayContaining(["useState", "Alert", "onClose", "true", "false", "null"]),
    );
  });
});

const PY_FETCH = [
  "def fetch_rows(client, table, timeout):",
  "    attempts = 0",
  "    while attempts < 3:",
  "        try:",
  "            with client.connect(timeout=timeout) as conn:",
  "                return [dict(row) for row in conn.query(table)]",
  "        except ConnectionError as err:",
  "            attempts += 1",
  '            log.warning("retry %s", err)',
  "    raise RuntimeError(table)",
];
const PY_FETCH_RENAMED = [
  "def read_all(db, name, wait):",
  "    tries = 0",
  "    while tries < 3:",
  "        try:",
  "            # The keyword argument keeps its name; only the value is local.",
  "            with db.connect(timeout=wait) as link:",
  "                return [dict(item) for item in link.query(name)]",
  "        except ConnectionError as exc:",
  "            tries += 1",
  '            log.warning("retry %s", exc)',
  "    raise RuntimeError(name)",
];
const TS_LOAD = [
  "export async function loadUser(api: Api, id: string): Promise<User | undefined> {",
  "  const { data, error } = await api.get(`/users/${id}`, { retries: 2 });",
  "  if (error) {",
  '    logger.warn("load failed", error);',
  "    return undefined;",
  "  }",
  "  const roles = data.roles.map((role) => role.name);",
  "  for (const [index, name] of roles.entries()) {",
  '    if (name === "admin") {',
  "      return { ...data, primary: index };",
  "    }",
  "  }",
  "  try {",
  "    return parseUser(data);",
  "  } catch (cause) {",
  "    throw new LoadError(id, cause);",
  "  }",
  "}",
];
const TS_LOAD_RENAMED = [
  "export async function readAccount(client: Api, key: string): Promise<User | undefined> {",
  "  const { data, error } = await client.get(`/users/${key}`, { retries: 2 });",
  "  if (error) {",
  '    logger.warn("load failed", error);',
  "    return undefined;",
  "  }",
  "  const labels = data.roles.map((entry) => entry.name);",
  "  for (const [position, label] of labels.entries()) {",
  '    if (label === "admin") {',
  "      return { ...data, primary: position };",
  "    }",
  "  }",
  "  try {",
  "    return parseUser(data);",
  "  } catch (reason) {",
  "    throw new LoadError(key, reason);",
  "  }",
  "}",
];

describe("local variables across real syntax", () => {
  it.each([
    {
      language: "python",
      original: file("a.py", PY_FETCH),
      renamed: file("b.py", PY_FETCH_RENAMED),
      other: file(
        "c.py",
        PY_FETCH.map((line) => line.replace("client.connect", "client.open_session")),
      ),
    },
    {
      language: "typescript",
      original: file("a.ts", TS_LOAD),
      renamed: file("b.ts", TS_LOAD_RENAMED),
      other: file(
        "c.ts",
        TS_LOAD.map((line) => line.replace("api.get", "api.post")),
      ),
    },
  ])("finds a $language method whose locals were renamed as identical", (sources) => {
    expect(sources.renamed.source).not.toBe(sources.original.source);
    const index = buildIndex([sources.original, sources.renamed, sources.other]);
    expect(index.stats).toMatchObject({ methods: 3, duplicateMethods: 0 });
    const [query, ...rest] = queriesFromLines(index, sources.original, allLines(sources.original));
    expect(rest).toEqual([]);
    const results = search(index, query!);
    expect(results.map((result) => result.method.path)).toEqual([
      sources.renamed.path,
      sources.other.path,
    ]);
    expect(results[0]!.similarity).toBe(1);
    expect(results[1]!.similarity).toBeLessThan(1);
    expect(results[1]!.similarity).toBeGreaterThan(0.65);
  });
});

describe("names declared outside a nested function", () => {
  const counter = (name: string, total: string) =>
    file(`${name}.py`, [
      `def ${name}(items):`,
      `    ${total} = 0`,
      "    def visit(item):",
      `        nonlocal ${total}`,
      "        global VISITS",
      `        ${total} += item.size`,
      "        VISITS += 1",
      "    for item in items:",
      "        visit(item)",
      `    return ${total}`,
    ]);

  it("keeps a variable local when a nested function declares it nonlocal", () => {
    const original = counter("count_sizes", "count");
    const [method] = methodsOf(python, original);
    expect(names(method!.body, true).sort()).toEqual(["count", "item", "items", "visit"]);
    expect(names(method!.body, false)).toEqual(expect.arrayContaining(["VISITS", "size"]));

    const index = buildIndex([original, counter("sum_sizes", "total")]);
    const [query] = queriesFromLines(index, original, allLines(original));
    expect(search(index, query!)[0]).toMatchObject({
      method: { name: "sum_sizes" },
      similarity: 1,
    });
  });
});

describe("indexing source files", () => {
  it("keeps methods whose tokens match but whose locals or nesting differ", () => {
    const index = buildIndex([
      file("global.ts", ["function readGlobal() {", "  return value;", "}"]),
      file("identity.ts", ["function identity(value: number) {", "  return value;", "}"]),
      file("inside.py", ["def inside(a):", "    if a:", "        log(a)", "        done(a)"]),
      file("after.py", ["def after(a):", "    if a:", "        log(a)", "    done(a)"]),
    ]);
    expect(index.methods.map((method) => method.name)).toEqual([
      "readGlobal",
      "identity",
      "inside",
      "after",
    ]);
    expect(index.stats).toMatchObject({ methods: 4, duplicateMethods: 0 });
  });

  it("reports every line of a matched token that spans lines", () => {
    const report = (name: string, table: string) =>
      file(`${name}.py`, [
        `def ${name}(db, ${table}):`,
        '    statement = """',
        "        SELECT id, total",
        "        FROM invoices",
        '    """',
        `    return db.run(statement, ${table})`,
      ]);
    const changed = report("load_invoices", "name");
    const index = buildIndex([changed, report("read_invoices", "table")]);
    const [query] = queriesFromLines(index, changed, [3]);
    expect(query!.lines).toEqual([3]);
    expect(search(index, query!)[0]).toMatchObject({
      method: { name: "read_invoices" },
      matchedLines: [2, 3, 4, 5],
    });
  });

  it("tells apart functions that start on one line and names each by its own declarator", () => {
    const callbacks = file("jobs.ts", [
      "register(() => one(), () => {",
      '  const rows = load("jobs");',
      "  audit(rows);",
      '  metrics.count("loaded", rows.length);',
      "  return rows.length;",
      "});",
      "const first = () => start(), second = () => {",
      "  stop();",
      "};",
    ]);
    expect(
      methodsOf(typescript, callbacks).map(({ name, startLine }) => [name, startLine]),
    ).toEqual([
      ["<anonymous>", 1],
      ["<anonymous>", 1],
      ["first", 7],
      ["second", 7],
    ]);
    const index = buildIndex([callbacks]);
    const query = queryFromSnippet(index, 'const rows = load("jobs");\naudit(rows);', {
      language: "typescript",
    })!;
    const [recommendation] = recommend(index, query, { minSupport: 1 });
    expect(recommendation!.method).toMatchObject({ name: "<anonymous>", startLine: 1, endLine: 6 });
    expect(recommendation!.lines.map((line) => [line.line, line.role])).toEqual([
      [1, "structure"],
      [2, "query"],
      [3, "query"],
      [4, "added"],
      [5, "added"],
      [6, "structure"],
    ]);
  });

  it("indexes a method once when only comments and layout differ", () => {
    const index = buildIndex([
      file("a.py", PY_FETCH),
      file("b.py", ["# A copy.", ...PY_FETCH.flatMap((line) => [line, ""])]),
      file("a.ts", TS_LOAD),
      file(
        "b.ts",
        TS_LOAD.map((line) => `${line} // same`),
      ),
    ]);
    expect(index.stats).toMatchObject({ files: 4, methods: 2, duplicateMethods: 2 });
    expect(index.methods.map((method) => method.path)).toEqual(["a.py", "a.ts"]);
  });

  describe("a function pasted into another file", () => {
    const original = file("lib/fetch.py", PY_FETCH);
    // The copy starts lower in its file and has a comment the original lacks.
    const pasted = file("api/handlers.py", [
      "import log",
      "",
      ...PY_FETCH.slice(0, 2),
      "    # Pasted from lib.",
      ...PY_FETCH.slice(2),
    ]);
    const originalRef = {
      path: "lib/fetch.py",
      name: "fetch_rows",
      language: "python",
      startLine: 1,
      endLine: 10,
    };
    const pastedRef = { ...originalRef, path: "api/handlers.py", startLine: 3, endLine: 13 };

    it.each([
      ["the copy", [pasted, original]],
      ["the original", [original, pasted]],
    ])("finds each from the other when %s is indexed first", (_, files) => {
      const index = buildIndex(files);
      expect(index.stats).toMatchObject({ methods: 1, duplicateMethods: 1 });
      const [fromPasted] = queriesFromLines(index, pasted, allLines(pasted));
      expect(search(index, fromPasted!)).toEqual([
        { method: originalRef, similarity: 1, matchedLines: [2, 3, 5, 6, 7, 8, 9, 10] },
      ]);
      const [fromOriginal] = queriesFromLines(index, original, allLines(original));
      expect(search(index, fromOriginal!)).toEqual([
        { method: pastedRef, similarity: 1, matchedLines: [4, 6, 8, 9, 10, 11, 12, 13] },
      ]);
    });

    it("leaves out only the copies a search excludes", () => {
      const index = buildIndex([pasted, original]);
      const [query] = queriesFromLines(index, original, [2, 3]);
      const anywhere = withoutOrigin(query!);
      const notIn = (source: SourceFile) => ({
        exclude: (method: { path: string }) => method.path === source.path,
      });
      expect(search(index, anywhere, notIn(pasted)).map((result) => result.method)).toEqual([
        originalRef,
      ]);
      expect(search(index, query!, notIn(pasted))).toEqual([]);
    });

    it("recommends from the copy a search may use, with that copy's lines", () => {
      const index = buildIndex([original, pasted]);
      const [query] = queriesFromLines(index, original, [2, 3]);
      const [recommendation] = recommend(index, query!, { minSupport: 1 });
      expect(recommendation!.method).toEqual(pastedRef);
      // Every line of the copy but its comment; the `def` line holds the body's colon.
      expect(recommendation!.lines.map((line) => line.line)).toEqual([
        3, 4, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
      expect(recommendation!.lines.slice(0, 3)).toEqual([
        { line: 3, text: "def fetch_rows(client, table, timeout):", role: "structure" },
        { line: 4, text: "    attempts = 0", role: "query" },
        { line: 6, text: "    while attempts < 3:", role: "query" },
      ]);
    });
  });

  it("skips files it cannot use and keeps going past syntax errors", () => {
    const index = buildIndex(
      [
        file("types.d.ts", ["export declare function f(x: number): void;"]),
        file("notes.md", ["# Notes"]),
        file("big.ts", TS_LOAD),
        file("broken.py", ["def ok(a):", "    return a + 1", "", "def broken(:", "    return ("]),
      ],
      { maxFileLength: 400 },
    );
    expect(index.stats).toMatchObject({ files: 2, unsupportedFiles: 1, oversizedFiles: 1 });
    expect(index.methods.map((method) => method.name)).toContain("ok");
  });
});

describe("queries from changed lines", () => {
  const changed = file("billing.py", [
    "LIMIT = 3",
    "",
    "def charge(client, account):",
    "    invoice = client.invoices.create(account=account.id)",
    "    client.invoices.finalize(invoice.id)",
    "    return invoice",
    "",
    "def refund(client, charge_id):",
    "    return client.refunds.create(charge=charge_id)",
  ]);
  const twin = file("legacy.py", [
    "def bill(api, customer):",
    "    draft = api.invoices.create(account=customer.id)",
    "    api.invoices.finalize(draft.id)",
    '    audit.record("billed", customer.id)',
    "    return draft",
  ]);
  const index = buildIndex([changed, twin]);

  it("makes one query per method with code on the lines, and none for module-level code", () => {
    const queries = queriesFromLines(index, changed, [1, 2, 4, 5]);
    expect(queries.map(({ origin, lines }) => ({ origin, lines }))).toEqual([
      {
        origin: {
          path: "billing.py",
          name: "charge",
          language: "python",
          startLine: 3,
          endLine: 6,
        },
        lines: [4, 5],
      },
    ]);
    expect(queriesFromLines(index, file("notes.md", ["x"]), [1])).toEqual([]);
  });

  it("searches the rest of the corpus, not the method the lines are in", () => {
    const [query] = queriesFromLines(index, changed, [4, 5]);
    const results = search(index, query!);
    expect(results[0]).toMatchObject({
      method: { path: "legacy.py", name: "bill" },
      matchedLines: [2, 3],
    });
    expect(results.map((result) => result.method.name)).not.toContain("charge");
    expect(search(index, withoutOrigin(query!))[0]).toMatchObject({
      method: { name: "charge" },
      similarity: 1,
      matchedLines: [4, 5],
    });
  });
});

describe("queries from snippets", () => {
  it("reads names a snippet does not declare as locals unless told they are global", () => {
    const index = buildIndex([
      file("load.py", [
        "import json",
        "",
        "def load(raw):",
        "    data = json.loads(raw)",
        '    return data["items"]',
      ]),
    ]);
    const source = "data = json.loads(text)";
    const guessed = queryFromSnippet(index, source, { language: "python" })!;
    const told = queryFromSnippet(index, source, {
      language: "python",
      globals: new Set(["json"]),
    })!;
    expect(search(index, told)[0]!.similarity).toBeGreaterThan(
      search(index, guessed)[0]!.similarity,
    );
    expect(queryFromSnippet(index, "# nothing here", { language: "python" })).toBeUndefined();
    expect(queryFromSnippet(index, source, { language: "cobol" })).toBeUndefined();
    expect(queryFromSnippet(index, "const a = b;", { path: "x.ts" })!.language).toBe("typescript");
  });

  it("keeps the names a snippet imports, calls, or capitalizes", () => {
    const script = typescript.parseSnippet(
      [
        'import { cache, type Row } from "./cache.ts";',
        "const rows: Row[] = await load(source, Limits.max);",
        "cache.set(key, new Table(rows));",
      ].join("\n"),
    )!;
    expect(names(script, true).sort()).toEqual(["key", "rows", "source"]);
    expect(names(script, false)).toEqual(
      expect.arrayContaining(["cache", "load", "Limits", "Table"]),
    );
    const module = python.parseSnippet(
      ["    import os", "    target = os.path.join(root, name)", "    return Path(target)"].join(
        "\n",
      ),
    )!;
    expect(names(module, true).sort()).toEqual(["name", "root", "target"]);
    expect(names(module, false)).toEqual(expect.arrayContaining(["os", "path", "join", "Path"]));
  });
});

// The paper's running example, Listings 4 to 7, in TypeScript: the query is
// Listing 4, `arcbit.ts` is Listing 5, `applozic.ts` is Listing 6, and the
// recommendation is Listing 7, which is Listing 5 without the one statement
// Listing 6 does not share.
const LISTING_5 = file("arcbit.ts", [
  "export function setupUIToHideKeyBoardOnTouch(view: View): void {",
  "  if (!(view instanceof EditText)) {",
  "    view.setOnTouchListener({",
  "      onTouch(v: View, event: MotionEvent): boolean {",
  "        hideKeyBoard();",
  "        return false;",
  "      },",
  "    });",
  "  }",
  "  if (view instanceof ViewGroup) {",
  "    for (let i = 0; i < view.getChildCount(); i++) {",
  "      const innerView = view.getChildAt(i);",
  "      setupUIToHideKeyBoardOnTouch(innerView);",
  "    }",
  "  }",
  "}",
]);
const LISTING_6 = file("applozic.ts", [
  "export function setupUI(view: View): void {",
  "  if (!(view instanceof EditText)) {",
  "    view.setOnTouchListener({",
  "      onTouch(v: View, event: MotionEvent): boolean {",
  "        Utils.toggleSoftKeyBoard(activity, true);",
  "        return false;",
  "      },",
  "    });",
  "  }",
  "  if (view instanceof ViewGroup) {",
  "    for (let i = 0; i < view.getChildCount(); i++) {",
  "      const innerView = view.getChildAt(i);",
  "      setupUI(innerView);",
  "    }",
  "  }",
  "}",
]);
const LISTING_4 = [
  "if (view instanceof ViewGroup) {",
  "  for (let i = 0; i < view.getChildCount(); i++) {",
  "    const innerView = view.getChildAt(i);",
  "  }",
  "}",
].join("\n");

describe("recommendations from source files", () => {
  it("reproduces the paper's running example", () => {
    const index = buildIndex([
      LISTING_5,
      LISTING_6,
      file("store.ts", TYPESCRIPT_MODULE.source.split("\n")),
    ]);
    const query = queryFromSnippet(index, LISTING_4, { language: "typescript" })!;
    const [recommendation, ...rest] = recommend(index, query);
    expect(rest).toEqual([]);
    expect(recommendation!.members.map((member) => member.name)).toEqual([
      "setupUIToHideKeyBoardOnTouch",
      "setupUI",
    ]);
    expect(recommendation!.similarity).toBeGreaterThan(0.9);
    const source = LISTING_5.source.split("\n");
    const expected = (line: number, role: string) => ({ line, text: source[line - 1], role });
    expect(recommendation!.lines).toEqual([
      expected(1, "structure"),
      expected(2, "added"),
      expected(3, "added"),
      expected(4, "added"),
      expected(6, "added"),
      expected(7, "structure"),
      expected(8, "structure"),
      expected(9, "structure"),
      expected(10, "query"),
      expected(11, "query"),
      expected(12, "query"),
      expected(13, "added"),
      expected(14, "structure"),
      expected(15, "structure"),
      expected(16, "structure"),
    ]);
    expect(recommendation!.code.split("\n")[1]).toBe("  if (!(view instanceof EditText)) {");
  });

  it("recommends the error handling that python methods share around a request", () => {
    const fetcher = (name: string, what: string, tail: string[]) =>
      file(`${what}.py`, [
        `def ${name}(session, url):`,
        "    try:",
        "        response = session.get(url, timeout=30)",
        "        response.raise_for_status()",
        "        payload = response.json()",
        "    except requests.RequestException as error:",
        `        logger.warning("${what} fetch failed: %s", error)`,
        "        return None",
        ...tail,
      ]);
    const index = buildIndex([
      fetcher("fetch_profile", "profile", [
        '    metrics.increment("profile.fetched")',
        "    return Profile.from_dict(payload)",
      ]),
      fetcher("fetch_invoices", "invoice", [
        "    cache.put(url, payload)",
        '    return payload["invoices"]',
      ]),
      fetcher("fetch_teams", "team", ['    return [Team(**item) for item in payload["teams"]]']),
      file("unrelated.py", [
        "def total(rows):",
        "    amount = 0",
        "    for row in rows:",
        "        amount += row.price * row.quantity",
        "    return amount",
      ]),
    ]);
    const query = queryFromSnippet(
      index,
      "response = session.get(url, timeout=30)\npayload = response.json()",
      { language: "python" },
    )!;
    const [recommendation] = recommend(index, query);
    expect(recommendation!.method).toMatchObject({ path: "profile.py", name: "fetch_profile" });
    expect(recommendation!.members.map((member) => member.name).sort()).toEqual([
      "fetch_invoices",
      "fetch_profile",
      "fetch_teams",
    ]);
    const roles = new Map(recommendation!.lines.map((line) => [line.line, line.role]));
    expect([2, 3, 4, 5, 6, 7, 8].map((line) => roles.get(line))).toEqual([
      "structure",
      "query",
      "added",
      "query",
      "added",
      "added",
      "added",
    ]);
    expect(roles.has(9)).toBe(false);
    expect(recommendation!.code).toContain("response.raise_for_status()");
    expect(recommendation!.code).not.toContain("metrics.increment");
  });
});
