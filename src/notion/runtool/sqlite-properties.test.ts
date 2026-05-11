/**
 * Golden-payload tests pinning the Notion REST → SQLite property
 * conversion against the empirical wire shape observed during
 * PR #538's live verification step (issue #533).
 *
 * The reference values in this file came from a `query_data_sources`
 * read against an existing `mentions` fact in an internal
 * vault Facts DB (`collection://eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee`)
 * at PR review time. The data-source schema declared on that DS is
 * the authoritative shape every fact lands as on disk; mirroring it
 * on writes — title/rich_text as bare strings, dates expanded into
 * 3 keys, relations as JSON-stringified URL arrays — is the
 * load-bearing contract for RunTool's `create_pages` accepting the
 * payload.
 *
 * If a future schema-pin refresh changes any of these expectations
 * (e.g. relation URL form changes from `notion.so` to `notion.com`,
 * or `is_datetime` flips from integer to boolean), this file is the
 * single update point alongside `sqlite-properties.ts`.
 */

import { describe, expect, it } from "vitest"
import {
  convertNotionRestToSqliteProperties,
  RELATION_URL_BASE_DEFAULT,
} from "./sqlite-properties.js"

describe("convertNotionRestToSqliteProperties — primitive types", () => {
  it("title → flat string", () => {
    const out = convertNotionRestToSqliteProperties({
      Subject: { title: [{ text: { content: "BaseView mentions iOS" } }] },
    })
    expect(out).toEqual({ Subject: "BaseView mentions iOS" })
  })

  it("rich_text → flat string (concatenates multi-segment runs)", () => {
    const out = convertNotionRestToSqliteProperties({
      Object: {
        rich_text: [
          { text: { content: "Foo" } },
          { text: { content: " " } },
          { text: { content: "Bar" } },
        ],
      },
    })
    expect(out).toEqual({ Object: "Foo Bar" })
  })

  it("rich_text → empty string when no segments", () => {
    const out = convertNotionRestToSqliteProperties({
      Object: { rich_text: [] },
    })
    expect(out).toEqual({ Object: "" })
  })

  it("select → flat string with the option name", () => {
    const out = convertNotionRestToSqliteProperties({
      Predicate: { select: { name: "mentions" } },
    })
    expect(out).toEqual({ Predicate: "mentions" })
  })

  it("select null → null (clear sentinel)", () => {
    const out = convertNotionRestToSqliteProperties({
      "Scope Kind": { select: null },
    })
    expect(out).toEqual({ "Scope Kind": null })
  })

  it("number → number primitive", () => {
    const out = convertNotionRestToSqliteProperties({
      "Confidence Score": { number: 0.3 },
    })
    expect(out).toEqual({ "Confidence Score": 0.3 })
  })

  it("number null → null", () => {
    const out = convertNotionRestToSqliteProperties({
      "Confidence Score": { number: null },
    })
    expect(out).toEqual({ "Confidence Score": null })
  })
})

describe("convertNotionRestToSqliteProperties — date 3-key expansion", () => {
  it("date with start only → 3 keys (start, end=null, is_datetime=0)", () => {
    const out = convertNotionRestToSqliteProperties({
      "Valid From": { date: { start: "2026-04-30" } },
    })
    expect(out).toEqual({
      "date:Valid From:start": "2026-04-30",
      "date:Valid From:end": null,
      "date:Valid From:is_datetime": 0,
    })
  })

  it("datetime (T separator) → is_datetime=1", () => {
    const out = convertNotionRestToSqliteProperties({
      "Valid From": { date: { start: "2026-04-30T12:34:56Z" } },
    })
    expect(out["date:Valid From:is_datetime"]).toBe(1)
    expect(out["date:Valid From:start"]).toBe("2026-04-30T12:34:56Z")
  })

  it("date null → all 3 keys null (clear sentinel)", () => {
    const out = convertNotionRestToSqliteProperties({
      "Valid Until": { date: null },
    })
    expect(out).toEqual({
      "date:Valid Until:start": null,
      "date:Valid Until:end": null,
      "date:Valid Until:is_datetime": null,
    })
  })

  it("date with start + end → both populated, is_datetime reflects start", () => {
    const out = convertNotionRestToSqliteProperties({
      "Valid Until": { date: { start: "2026-04-30", end: "2026-05-30" } },
    })
    expect(out).toEqual({
      "date:Valid Until:start": "2026-04-30",
      "date:Valid Until:end": "2026-05-30",
      "date:Valid Until:is_datetime": 0,
    })
  })
})

describe("convertNotionRestToSqliteProperties — relation as JSON URL array", () => {
  it("single-id relation under default base → www.notion.so URL", () => {
    const out = convertNotionRestToSqliteProperties({
      Project: {
        relation: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      },
    })
    // Default base is the production host. Tests that don't pass
    // a base use this default; production callers MUST pass the
    // derived base via `services.ts:deriveRelationUrlBase` because
    // host-mismatched URLs are rejected by the server (PR #538
    // live verification).
    expect(out).toEqual({
      Project: '["https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
    })
  })

  it("single-id relation under dev base → dev.notion.so URL (host-coupling pinned)", () => {
    // Empirical reference (PR #538 live verification): rows in
    // a dev workspace store relations as `https://dev.notion.so/<id>`
    // and the server REJECTS `https://www.notion.so/<id>` against
    // the same workspace with `400 validation_error: Invalid page
    // URL`. This test pins the host-coupling — a regression that
    // hardcoded the production host would silently break dev
    // workspaces (the entire internal vault is on dev).
    const out = convertNotionRestToSqliteProperties(
      {
        Project: {
          relation: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        },
      },
      "https://dev.notion.so/"
    )
    expect(out).toEqual({
      Project: '["https://dev.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
    })
  })

  it("exposes the production default base as a public constant", () => {
    expect(RELATION_URL_BASE_DEFAULT).toBe("https://www.notion.so/")
  })

  it("multi-id relation → JSON-stringified array preserving order", () => {
    const out = convertNotionRestToSqliteProperties({
      Project: {
        relation: [
          { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        ],
      },
    })
    expect(out).toEqual({
      Project:
        '["https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
    })
  })

  it("dashed UUIDs are normalized to undashed lowercase before URL construction", () => {
    const out = convertNotionRestToSqliteProperties({
      SubjectEntity: {
        relation: [{ id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" }],
      },
    })
    expect(out).toEqual({
      SubjectEntity:
        '["https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
    })
  })

  it("empty relation → JSON-stringified empty array (clears the column)", () => {
    const out = convertNotionRestToSqliteProperties({
      Project: { relation: [] },
    })
    expect(out).toEqual({ Project: "[]" })
  })
})

describe("convertNotionRestToSqliteProperties — full mentions-fact payload", () => {
  it("matches the empirical wire shape of an existing mentions fact", () => {
    // Reference data: a real `mentions` fact pulled from the
    // an internal vault during PR #538 live verification:
    //   id: bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
    //   subject: "WebView: customSchemeHandler.update(with:) ..."
    //   object: "BaseView"
    //   predicate: "mentions"
    //   confidence: "speculative"
    //   confidenceScore: 0.3
    //   validFrom: "2026-04-30"
    //   sourceMemoryId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    //   projectIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    //   subjectEntity: "cccccccccccccccccccccccccccccccc"
    //   objectEntity: "dddddddddddddddddddddddddddddddd"
    //
    // The Notion REST shape `buildFactProps` produces for that
    // input is exactly what we feed the converter here.
    const notionRestProps = {
      Subject: {
        title: [
          {
            text: {
              content:
                "WebView: customSchemeHandler.update(with:) must be unconditional in updateUIView",
            },
          },
        ],
      },
      Predicate: { select: { name: "mentions" } },
      Object: { rich_text: [{ text: { content: "BaseView" } }] },
      Project: {
        relation: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      },
      "Valid From": { date: { start: "2026-04-30" } },
      Source: {
        relation: [{ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
      },
      Confidence: { select: { name: "speculative" } },
      DedupKey: { rich_text: [{ text: { content: "abc123dedup" } }] },
      SubjectKey: {
        rich_text: [
          {
            text: {
              content:
                "webview: customschemehandler.update(with:) must be unconditional in updateuiview",
            },
          },
        ],
      },
      SubjectEntity: {
        relation: [{ id: "cccccccccccccccccccccccccccccccc" }],
      },
      ObjectEntity: {
        relation: [{ id: "dddddddddddddddddddddddddddddddd" }],
      },
    }

    const out = convertNotionRestToSqliteProperties(notionRestProps)

    expect(out).toEqual({
      Subject:
        "WebView: customSchemeHandler.update(with:) must be unconditional in updateUIView",
      Predicate: "mentions",
      Object: "BaseView",
      Project: '["https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]',
      "date:Valid From:start": "2026-04-30",
      "date:Valid From:end": null,
      "date:Valid From:is_datetime": 0,
      Source: '["https://www.notion.so/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
      Confidence: "speculative",
      DedupKey: "abc123dedup",
      SubjectKey:
        "webview: customschemehandler.update(with:) must be unconditional in updateuiview",
      SubjectEntity:
        '["https://www.notion.so/cccccccccccccccccccccccccccccccc"]',
      ObjectEntity:
        '["https://www.notion.so/dddddddddddddddddddddddddddddddd"]',
    })
  })
})

describe("convertNotionRestToSqliteProperties — defensive shapes", () => {
  it("ignores null / undefined property values", () => {
    const out = convertNotionRestToSqliteProperties({
      Subject: null,
      Object: undefined,
      Predicate: { select: { name: "mentions" } },
    })
    expect(out).toEqual({ Predicate: "mentions" })
  })

  it("ignores unrecognized property shapes (passes through nothing)", () => {
    const out = convertNotionRestToSqliteProperties({
      // No discriminator key the converter recognizes.
      Mystery: { foo: "bar" },
      Predicate: { select: { name: "mentions" } },
    })
    expect(out).toEqual({ Predicate: "mentions" })
  })

  it("rejects malformed select payloads (no .name) → null", () => {
    const out = convertNotionRestToSqliteProperties({
      Predicate: { select: { color: "red" } },
    })
    expect(out).toEqual({ Predicate: null })
  })
})
