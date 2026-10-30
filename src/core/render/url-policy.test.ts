/**
 * URL policy unit tests (threat T1/T4, FR-022/023, ADR-003).
 * The shapes mirror fixtures/hostile-input/javascript-url.md and
 * tracking-pixel.md, plus legitimate forms that must survive.
 */
import { describe, expect, it } from "vitest";
import { classifyUrl, safeUrl } from "./url-policy";

describe("classifyUrl — allowed shapes", () => {
  it("classifies fragments", () => {
    expect(classifyUrl("#intro")).toBe("fragment");
    expect(classifyUrl("#heading-with-dashes")).toBe("fragment");
    expect(classifyUrl("  #frag")).toBe("fragment");
  });

  it("classifies relative refs (spaces survive)", () => {
    expect(classifyUrl("docs/guide.md")).toBe("relative");
    expect(classifyUrl("./assets/diagram.png")).toBe("relative");
    expect(classifyUrl("../sibling.md")).toBe("relative");
    expect(classifyUrl("my doc.md")).toBe("relative");
  });

  it("classifies local-media", () => {
    expect(classifyUrl("local-media:/Users/x/a.png")).toBe("localMedia");
  });

  it("classifies remote and mailto", () => {
    expect(classifyUrl("https://example.com")).toBe("remote");
    expect(classifyUrl("http://example.com")).toBe("remote");
    expect(classifyUrl("mailto:x@example.com")).toBe("mailto");
  });
});

describe("classifyUrl — blocked shapes (T1)", () => {
  const blocked = [
    "javascript:alert('a')",
    "JavaScript:alert('c')",
    "jAvAsCrIpT:alert('d')",
    "java\tscript:alert('control')",
    "java\nscript:alert('newline')",
    "java script:alert('space')",
    "java&#115;cript:alert('entity')",
    "javascript&colon;alert('named-entity')",
    "java&amp;#115;cript:alert('double-entity')",
    "vbscript:msgbox('x')",
    "data:text/html,<script>alert('data')</script>",
    "data:application/javascript,alert('data2')",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgnZDInKTwvc2NyaXB0Pg==",
    "data:\ttext/html,tab-in-scheme",
    "file:///etc/passwd",
    "file:///Users/someone/secrets.md",
    "ftp://files.example/x",
    "feed://rss.example",
    "",
    "   ",
  ];

  for (const url of blocked) {
    it(`blocks ${JSON.stringify(url)}`, () => {
      expect(classifyUrl(url)).toBe("blocked");
    });
  }
});

describe("safeUrl — link usage", () => {
  it("keeps allowed links verbatim", () => {
    expect(safeUrl("https://example.com/a?b=c", "link")).toBe(
      "https://example.com/a?b=c",
    );
    expect(safeUrl("#frag", "link")).toBe("#frag");
    expect(safeUrl("docs/guide.md", "link")).toBe("docs/guide.md");
    expect(safeUrl("mailto:x@example.com", "link")).toBe("mailto:x@example.com");
  });

  it("empties blocked links (inert, visible text)", () => {
    expect(safeUrl("javascript:alert(1)", "link")).toBe("");
    expect(safeUrl("file:///etc/passwd", "link")).toBe("");
    expect(safeUrl("data:text/html,x", "link")).toBe("");
  });

  it("never allows local-media as a link", () => {
    expect(safeUrl("local-media:/etc/hostname", "link")).toBe("");
  });
});

describe("safeUrl — image usage (T4: remote off by default)", () => {
  it("keeps local-media images", () => {
    expect(safeUrl("local-media:/Users/x/a.png", "image")).toBe(
      "local-media:/Users/x/a.png",
    );
  });

  it("keeps relative images for document resolution", () => {
    expect(safeUrl("./assets/diagram.png", "image")).toBe("./assets/diagram.png");
  });

  it("blocks remote images", () => {
    expect(safeUrl("https://tracking.example/px.gif", "image")).toBe("");
    expect(safeUrl("http://insecure.example/1x1.png", "image")).toBe("");
  });

  it("blocks data: images", () => {
    expect(safeUrl("data:image/gif;base64,R0lGOD", "image")).toBe("");
  });
});
