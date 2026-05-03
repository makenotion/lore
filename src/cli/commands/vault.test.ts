import { describe, expect, it } from "vitest"
import { formatEnsureEntitiesResult } from "./vault.js"

describe("formatEnsureEntitiesResult", () => {
  it("reports a dry-run creation plan without pretending schema drift was computed", () => {
    expect(
      formatEnsureEntitiesResult({
        pageId: "page-1",
        ensure: { status: "would-create" },
        diffs: [],
      })
    ).toEqual([
      "Would create the Entities database on the configured vault page.",
      "Would run schema migration after creation so Facts gains SubjectEntity/ObjectEntity relation columns.",
    ])
  })

  it("reports created Entities and the follow-up Facts relation columns", () => {
    const output = formatEnsureEntitiesResult({
      pageId: "page-1",
      ensure: {
        status: "created",
        ref: { databaseId: "entities-db", dataSourceId: "entities-ds" },
      },
      diffs: [
        {
          database: "facts",
          missing: ["SubjectEntity", "ObjectEntity"],
          addedOptions: [],
          addedRelationConfig: [],
        },
      ],
    }).join("\n")

    expect(output).toContain("Created Entities database: entities-db")
    expect(output).toContain("Added 2 missing properties")
    expect(output).toContain("facts: SubjectEntity, ObjectEntity")
  })

  it("reports an already-up-to-date vault", () => {
    expect(
      formatEnsureEntitiesResult({
        pageId: "page-1",
        ensure: {
          status: "present",
          ref: { databaseId: "entities-db", dataSourceId: "entities-ds" },
        },
        diffs: [
          {
            database: "projects",
            missing: [],
            addedOptions: [],
            addedRelationConfig: [],
          },
        ],
      })
    ).toEqual([
      "Entities database already exists: entities-db",
      "Vault schema is up to date.",
    ])
  })
})
