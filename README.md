# Aroma

An implementation of [Aroma: Code Recommendation via Structural Code Search](https://arxiv.org/abs/1812.01158) (Luan, Yang, Barnaby, Sen, Chandra; OOPSLA 2019). Section, listing, and symbol names below are the paper's.

Given a piece of code, Aroma finds the methods of a corpus that contain code like it, groups the ones that are alike, and returns the code each group shares around the query. For a code review, the corpus can be the repository's checkout and the query the code a pull request changed, so a recommendation reads as "the functions that already do this also do that".

It reads no files, calls no model or network, and writes nothing: the caller passes it source text.

## Setup

Requires Node.js 22.18 or later and [pnpm](https://pnpm.io/).

```sh
pnpm install
pnpm test       # Vitest
pnpm typecheck  # tsc --noEmit
```

The package ships TypeScript source (`src/index.ts`) with no build step, so import it from a TypeScript-aware toolchain such as Vite, Vitest, tsx, or Bun.

## How It Works

Files are under `src/`.

| Stage                                                                                                                                                                                       | Paper | File                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------ |
| Parse each method body into a simplified parse tree: nested lists of tokens with no grammar-specific node types.                                                                            | 3.1   | `languages/`, `tree.ts`  |
| Give each name and literal its features: itself, its place under up to three ancestors, its neighbors, and how consecutive uses of a local variable relate. Local variables are all `#VAR`. | 3.2   | `features.ts`            |
| Phase I: score every method by how many of the query's distinct features it has, and keep the top 1000 (η1).                                                                                | 3.3.1 | `corpus.ts`, `search.ts` |
| Phase II: prune each of those down to the tokens that resemble the query (Algorithm 1) and rerank by how much of the query the pruned snippet has.                                          | 3.3.2 | `prune.ts`, `search.ts`  |
| Phase III: cluster the top 100 (η2) above 0.65 similarity (τ1), intersect each cluster down to the code its methods share, and return the first 5 (K).                                      | 3.3.3 | `recommend.ts`           |

## Usage

```ts
import { buildIndex, queriesFromLines, recommend, search } from "aroma-typescript";

// Once per corpus: every source file, as text.
const index = buildIndex(files); // files: Iterable<{ path, source }>

// Per changed file: one query per function with code on the changed lines.
for (const query of queriesFromLines(index, { path, source }, changedLines)) {
  if (query.size < 30) {
    continue; // Too little code to say anything about; see Limits.
  }
  // Existing functions that contain code like the change, most similar first.
  const similar = search(index, query, { minSimilarity: 0.71, limit: 3 });
  // Code that at least two existing functions share around code like the change.
  const recommendations = recommend(index, query);
}
```

- A query from `queriesFromLines` never matches the function it was cut from. Pass `exclude` to leave out other methods, such as ones a pull request added. An identical copy elsewhere of a function left out either way is still found.
- `search` is Aroma's code-to-code search on its own. A result's `similarity` is the share of the query's features found in the part of the method that resembles it. The paper treats 0.71 and up as "a programmer could adapt the existing code with minimal changes" (Section 2).
- A `Recommendation` has the `method` its lines come from, the cluster's `members`, and `lines` with a `role` each: `query` for lines that resemble the query, `added` for code the cluster shares beyond it, and `structure` for lines of only keywords and punctuation around them. `code` is the lines' text.
- `queryFromSnippet` takes code that is not in a file, as the paper does. It has to guess which undeclared names are local variables; see Departures.
- `buildIndex(files, { languages })` takes other front ends. A `Language` (`src/language.ts`) turns source into simplified parse trees and says which names are local variables; nothing else is language-specific.

## Departures From The Paper

- **Corpus.** The paper indexes 5,417 GitHub projects. Here the corpus is whatever files the caller passes, such as one repository. The paper's own deployment indexed Facebook's codebase the same way (Section 6). η1, η2, and K keep the paper's values.
- **Languages and parser.** The paper covers Hack, Java, JavaScript, and Python with ANTLR parsers. This module covers Python and TypeScript/JavaScript (with JSX) with [Lezer](https://lezer.codemirror.net/) grammars, which are plain JavaScript and need no WebAssembly or native build. Lezer recovers from syntax it does not know instead of failing; on a large Python and TypeScript monorepo, 1.5% to 2% of functions contain a node it could not parse, such as Python t-strings and some TypeScript type predicates, and their trees are slightly off in the same way in the corpus and in a query.
- **Local variables.** The paper uses each language's scoping rules. A Python name is local when the function binds it (parameters, assignment and loop targets, `with` and `except` aliases, nested functions and classes) and does not import it or declare it `global`. A name a nested function declares `nonlocal` stays local, since the enclosing function is part of the same method. A TypeScript name is local when the function declares it. Two variables with one name in nested scopes count as one.
- **Methods.** A method is an outermost function or class method. Nested functions and callbacks are part of the method around them, so a `describe` callback is one method. Module-level code is not indexed. Docstrings are dropped along with comments.
- **Literals.** `true`, `false`, `null`, `None`, and `...` are literals, as in the Java grammar the paper uses, so a statement such as `return false;` has a token to match on.
- **Queries from changed lines.** `queriesFromLines` featurizes the tokens on the given lines inside their method, where their ancestors and local variables are known, instead of parsing the lines alone. Neighbors and consecutive uses are found among the selected tokens only, as they would be in a snippet.
- **Queries from snippets.** A snippet does not show whether a name it never declares is a local variable. `queryFromSnippet` takes it to be one unless it is called, capitalized, imported in the snippet, or passed in `globals`. The paper's examples imply the same guess for names such as `view` in Listing 4.
- **Similarity threshold τ1.** The paper applies 0.65 to an "overlap score with the query" that it otherwise defines as a count. Here it applies to the Phase II similarity: the pruned snippet's features shared with the query, divided by the query's.
- **Cluster cohesion.** The paper's formula for s(τ) divides by the first method's features, which no cluster could pass together with l(τ) > 1.5. Its prose says the pruned snippets should match the first _pruned_ snippet, so s(τ) divides by the first pruned snippet's features.
- **Growing clusters.** A cluster grows by the later method with the highest l(τ) among those that keep it valid. Read literally, the paper's definition also lets a method that would make the cluster invalid block the growth. Only the fully grown cluster is kept, not each smaller cluster it grew through, which the definition would also include. On a tie the higher-ranked method wins.
- **Unclustered methods.** The paper also returns each method that clustered with nothing, and its rule for dropping similar clusters leaves the last member of many clusters on its own. `recommend` returns only clusters of two or more methods, so a recommendation is always code that recurs. With `minSupport: 1` it returns the paper's set, where a cluster of one is the whole method, as Section 4.3.5 describes, not the method pruned to the query, as the definition of Intersect would give.
- **Showing a recommendation.** The paper prints the pruned tree. This module returns whole source lines: every line with a kept token, and the keyword and punctuation lines of the trees around them. The paper's listings read the same way.
- **Pruning.** Algorithm 1 rescans every token for the best one at each step. `prune` picks the same tokens by rechecking them from the highest earlier gain down, which is valid because a token's gain never grows. Ties go to the earlier token.
- **Light-weight search.** The paper multiplies a sparse method-by-feature matrix by the query vector. `search` computes the same product from the matrix stored by feature.
- **Duplicates.** The paper drops duplicate projects, files, and methods by hash. `buildIndex` indexes once each group of methods with the same tokens, local variables, and nesting, which is everything their features are computed from, and records where the others are. A search answers with the first of them it may use, so pasting a function into another file still finds the original, whichever file comes first.
- **Long literals.** A literal over 48 characters is featurized by its first 48 characters and its length.

## Limits

- **Small queries say little.** Every local variable is `#VAR`, so a query of one or two short lines resembles a lot of unrelated code, and methods that share nothing else can cluster around it. The paper's queries had 10 to 100 features. Check `query.size` before trusting a result.
- **Recommendations are approximate.** Pruning keeps a token when any one of its features is still unmatched in the target, so a line can be kept for a single variable on it. Treat `added` lines as leads for a reviewer to judge, not as findings.
- **Cost.** Indexing a Python and TypeScript monorepo (9,222 Python and TypeScript files, 64 MB, 57,770 methods after dropping 4,469 duplicates) takes about 55 seconds on one core and holds about 480 MB, including the sources. A search then takes about 70 ms and a recommendation about 80 ms. Nothing is cached between runs.
- **Recall.** On the paper's Section 5 benchmark run over that monorepo (300 functions per language, 5-line queries), the function a query was cut from ranks first for 100% of contiguous and 99.6% to 100% of scattered line queries. For the same lines parsed alone as snippets it ranks first for 95.9% (Python) and 93.1% (TypeScript); the paper reports 97.5% for Python and 93.9% for JavaScript.
