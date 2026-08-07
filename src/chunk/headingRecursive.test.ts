import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitHeadingRecursive, estimateTokens } from "./headingRecursive.js";
import { buildEmbedInput, buildEmbedInputCoreOnly } from "./embedText.js";

describe("headingRecursive", () => {
  it("strips frontmatter and splits by headings", () => {
    const md = `---
doc_id: x
---

# Title

intro para

## Section A

body a

## Section B

body b
`;
    const { pieces } = splitHeadingRecursive(md, { maxTokens: 512, overlapTokens: 0 });
    assert.ok(pieces.length >= 2);
    assert.ok(pieces.some((p) => p.headingPath.includes("Section A")));
    assert.ok(pieces.every((p) => !p.text.includes("doc_id:")));
    for (const p of pieces) {
      assert.ok(p.end > p.start);
    }
  });

  it("recursive splits long section", () => {
    const long = "字".repeat(2000);
    const md = `# H\n\n${long}`;
    const { pieces } = splitHeadingRecursive(md, { maxTokens: 100, overlapTokens: 10 });
    assert.ok(pieces.length > 1);
    for (const p of pieces) {
      assert.ok(estimateTokens(p.text) <= 120);
    }
  });

  it("exposes offsets usable for neighbor window", () => {
    const md = `# A\n\nhello world\n\n# B\n\nfoo bar baz`;
    const { body, pieces } = splitHeadingRecursive(md, { maxTokens: 512, overlapTokens: 0 });
    assert.ok(pieces.length >= 2);
    const p0 = pieces[0];
    assert.equal(body.slice(p0.start, p0.end), p0.text);
  });
});

describe("embedText enrich", () => {
  it("includes neighbor and meta; core stored separately", () => {
    const body = "AAAA_CORE_BBBB_EXTRA";
    const core = "CORE";
    const start = body.indexOf(core);
    const end = start + core.length;
    const input = buildEmbedInput(
      body,
      core,
      start,
      end,
      { title: "T", path: "p.md", heading_path: "章" },
      { enabled: true, neighborChars: 5, meta: true, maxChars: 4000 },
    );
    assert.ok(input.includes("文档：T"));
    assert.ok(input.includes("章节：章"));
    assert.ok(input.includes("AAAA_")); // left 邻域
    assert.ok(input.includes("CORE"));
    assert.ok(input.includes("_BBBB")); // right 邻域
    assert.ok(input.includes("---"));
  });

  it("disabled returns core only", () => {
    const input = buildEmbedInput("xxYYzz", "YY", 2, 4, { title: "T" }, { enabled: false });
    assert.equal(input, "YY");
  });

  it("core-only upsert path has meta without neighbor from full doc", () => {
    const input = buildEmbedInputCoreOnly("hello", { title: "笔记", heading_path: "简介" }, {
      enabled: true,
      meta: true,
    });
    assert.ok(input.includes("文档：笔记"));
    assert.ok(input.includes("hello"));
  });
});
