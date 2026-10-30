/**
 * FR-013 editing commands: pure text transformations. Each test pins the
 * toggle semantics (apply → apply returns to the original) and the
 * selection the user should land with.
 */
import { describe, expect, it } from "vitest";
import { applyEditCommand } from "./edit-commands";

const sel = (from: number, to: number) => ({ from, to });

describe("wrap commands (toggle)", () => {
  it("bold wraps and unwraps", () => {
    const r1 = applyEditCommand("hello world", sel(0, 5), "bold")!;
    expect(r1.text).toBe("**hello** world");
    expect(r1.selection).toEqual(sel(2, 7));
    const r2 = applyEditCommand(r1.text, r1.selection, "bold")!;
    expect(r2.text).toBe("hello world");
  });

  it("italic wraps and unwraps", () => {
    const r1 = applyEditCommand("word", sel(0, 4), "italic")!;
    expect(r1.text).toBe("*word*");
    const r2 = applyEditCommand(r1.text, r1.selection, "italic")!;
    expect(r2.text).toBe("word");
    // Already-italic text toggles off (selection over the inner "b").
    const r3 = applyEditCommand("a*b*c", sel(2, 3), "italic")!;
    expect(r3.text).toBe("abc");
  });

  it("code wraps inline selections", () => {
    const r1 = applyEditCommand("use foo here", sel(4, 7), "code")!;
    expect(r1.text).toBe("use `foo` here");
    const r2 = applyEditCommand(r1.text, r1.selection, "code")!;
    expect(r2.text).toBe("use foo here");
  });

  it("code on a multi-line selection produces a fence", () => {
    const r1 = applyEditCommand("a\nb", sel(0, 3), "code")!;
    expect(r1.text).toBe("```\na\nb\n```");
  });
});

describe("link", () => {
  it("wraps a selection and lands the caret in the URL", () => {
    const r1 = applyEditCommand("see example", sel(4, 11), "link")!;
    expect(r1.text).toBe("see [example](url)");
    expect(r1.selection.from).toBe(r1.text.indexOf("(") + 1);
    expect(r1.selection.from).toBe(r1.selection.to);
  });

  it("handles an empty selection", () => {
    const r1 = applyEditCommand("abc", sel(1, 1), "link")!;
    expect(r1.text).toBe("a[](url)bc");
    expect(r1.selection).toEqual(sel(4, 4));
  });
});

describe("heading (cycle #..######..none)", () => {
  it("adds, increments, and removes", () => {
    let r = applyEditCommand("Title", sel(0, 5), "heading")!;
    expect(r.text).toBe("## Title");
    r = applyEditCommand(r.text, r.selection, "heading")!;
    expect(r.text).toBe("### Title");
    // Cycle through to removal.
    r = applyEditCommand(r.text, r.selection, "heading")!;
    expect(r.text).toBe("#### Title");
    r = applyEditCommand(r.text, r.selection, "heading")!;
    expect(r.text).toBe("##### Title");
    r = applyEditCommand(r.text, r.selection, "heading")!;
    expect(r.text).toBe("###### Title");
    r = applyEditCommand(r.text, r.selection, "heading")!;
    expect(r.text).toBe("Title");
  });

  it("does not touch other lines", () => {
    const r1 = applyEditCommand("# keep\nline", sel(7, 11), "heading")!;
    expect(r1.text).toBe("# keep\n## line");
  });
});

describe("list / ordered list / quote (multi-line toggle)", () => {
  const two = "alpha\nbeta";

  it("list prefixes every spanned line and toggles off", () => {
    const r1 = applyEditCommand(two, sel(0, 10), "list")!;
    expect(r1.text).toBe("- alpha\n- beta");
    const r2 = applyEditCommand(r1.text, r1.selection, "list")!;
    expect(r2.text).toBe("alpha\nbeta");
  });

  it("list only touches spanned lines", () => {
    const r1 = applyEditCommand("keep\nalpha", sel(5, 10), "list")!;
    expect(r1.text).toBe("keep\n- alpha");
  });

  it("ordered list numbers sequentially and toggles off", () => {
    const r1 = applyEditCommand(two, sel(0, 10), "orderedList")!;
    expect(r1.text).toBe("1. alpha\n2. beta");
    const r2 = applyEditCommand(r1.text, r1.selection, "orderedList")!;
    expect(r2.text).toBe("alpha\nbeta");
  });

  it("quote prefixes and toggles off", () => {
    const r1 = applyEditCommand(two, sel(0, 10), "quote")!;
    expect(r1.text).toBe("> alpha\n> beta");
    const r2 = applyEditCommand(r1.text, r1.selection, "quote")!;
    expect(r2.text).toBe("alpha\nbeta");
  });
});

describe("fence", () => {
  it("fences a selection", () => {
    const r1 = applyEditCommand("before\ncode line\nafter", sel(7, 16), "fence")!;
    expect(r1.text).toBe("before\n```\ncode line\n```\nafter");
  });

  it("fences the current line on an empty selection", () => {
    const r1 = applyEditCommand("x\nsolo\ny", sel(3, 3), "fence")!;
    expect(r1.text).toBe("x\n```\nsolo\n```\ny");
  });
});

describe("task", () => {
  it("cycles plain → unchecked → checked → plain", () => {
    let r = applyEditCommand("buy milk", sel(0, 8), "task")!;
    expect(r.text).toBe("- [ ] buy milk");
    r = applyEditCommand(r.text, r.selection, "task")!;
    expect(r.text).toBe("- [x] buy milk");
    r = applyEditCommand(r.text, r.selection, "task")!;
    expect(r.text).toBe("buy milk");
  });

  it("turns an existing list item into a task", () => {
    const r1 = applyEditCommand("- item", sel(0, 6), "task")!;
    expect(r1.text).toBe("- [ ] item");
  });

  it("applies to every spanned line", () => {
    const r1 = applyEditCommand("one\ntwo", sel(0, 7), "task")!;
    expect(r1.text).toBe("- [ ] one\n- [ ] two");
  });
});

describe("safety", () => {
  it("never returns null for a non-empty document", () => {
    for (const cmd of [
      "bold", "italic", "code", "link", "heading",
      "list", "orderedList", "quote", "fence", "task",
    ] as const) {
      expect(applyEditCommand("doc", sel(1, 2), cmd)).not.toBeNull();
    }
  });

  it("tolerates boundary selections (empty wraps insert the marker pair)", () => {
    expect(applyEditCommand("abc", sel(0, 0), "bold")!.text).toBe("****abc");
    expect(applyEditCommand("abc", sel(0, 0), "bold")!.selection).toEqual(sel(2, 2));
    expect(applyEditCommand("abc", sel(3, 3), "italic")!.text).toBe("abc**");
    expect(applyEditCommand("abc", sel(3, 3), "italic")!.selection).toEqual(sel(4, 4));
    expect(applyEditCommand("", sel(0, 0), "bold")!.text).toBe("****");
  });
});
