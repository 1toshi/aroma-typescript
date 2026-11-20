import type { Language, ParsedMethod } from "../src/language.ts";
import type { Node, Token } from "../src/tree.ts";

const KEYWORDS = new Set(["if", "else", "for", "while", "int", "instanceof", "return", "new"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/;

/**
 * A language for writing the paper's examples as the simplified parse trees it
 * draws: `[` and `]` group a subtree, `$name` is a local variable, and words
 * and numbers are non-keyword tokens unless they are in `KEYWORDS`. Everything
 * else is a keyword token. Methods are `method <name>` ... `end` blocks.
 */
export const toy: Language = {
  id: "toy",
  extensions: [".toy"],
  parseMethods(source) {
    const methods: ParsedMethod[] = [];
    const lines = source.split("\n");
    let start = -1;
    let name = "";
    lines.forEach((line, index) => {
      const header = /^method (\S+)$/.exec(line.trim());
      if (header) {
        start = index + 1;
        name = header[1]!;
      } else if (line.trim() === "end") {
        const body = parse(lines.slice(start, index), start + 1);
        if (body) {
          methods.push({ name, startLine: start + 1, endLine: index, body });
        }
      }
    });
    return methods;
  },
  parseSnippet(source) {
    return parse(source.split("\n"), 1);
  },
};

function parse(lines: string[], firstLine: number): Node | undefined {
  const stack: Node[][] = [[]];
  lines.forEach((line, offset) => {
    for (const word of line.split(/\s+/).filter((part) => part !== "")) {
      if (word === "[") {
        stack.push([]);
      } else if (word === "]") {
        const children = stack.pop()!;
        stack.at(-1)!.push(collapse(children));
      } else {
        stack.at(-1)!.push(leaf(word, firstLine + offset));
      }
    }
  });
  const root = stack[0]!;
  return root.length === 0 ? undefined : collapse(root);
}

function collapse(children: Node[]): Node {
  return children.length === 1 && children[0]!.kind === "tree"
    ? children[0]!
    : { kind: "tree", children };
}

function leaf(word: string, line: number): Token {
  const local = word.startsWith("$");
  const text = local ? word.slice(1) : word;
  const keyword = !local && (KEYWORDS.has(text) || !NAME.test(text));
  return { kind: "token", text, keyword, local, line, endLine: line };
}
