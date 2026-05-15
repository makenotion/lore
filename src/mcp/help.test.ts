import { describe, expect, it, vi } from "vitest"
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import {
  HELP_RECIPES,
  findHelpRecipe,
  helpResourceUri,
  registerHelpResources,
  renderHelpIndex,
  renderHelpRecipe,
} from "./help.js"

type ResourceReadResult = {
  contents: Array<{ uri: string; mimeType?: string; text?: string }>
}

function createMockServer() {
  return {
    registerResource: vi.fn(),
  } as unknown as McpServer & {
    registerResource: ReturnType<typeof vi.fn>
  }
}

describe("Lore MCP help resources", () => {
  it("registers the static index and templated action resources", async () => {
    const server = createMockServer()
    registerHelpResources(server)

    expect(server.registerResource).toHaveBeenCalledTimes(2)

    const indexCall = server.registerResource.mock.calls[0]
    expect(indexCall[0]).toBe("lore-help")
    expect(indexCall[1]).toBe("lore://help")
    expect(indexCall[2]).toMatchObject({ mimeType: "text/markdown" })
    const indexResult = (await indexCall[3](
      new URL("lore://help"),
      {}
    )) as ResourceReadResult
    expect(indexResult.contents[0]).toMatchObject({
      uri: "lore://help",
      mimeType: "text/markdown",
    })
    expect(indexResult.contents[0]?.text).toContain("lore://help/lore-memory/save")
    expect(indexResult.contents[0]?.text).toContain(
      "not a replacement for runtime validation"
    )

    const actionCall = server.registerResource.mock.calls[1]
    expect(actionCall[0]).toBe("lore-help-action")
    expect(actionCall[1]).toBeInstanceOf(ResourceTemplate)
    expect(actionCall[1].uriTemplate.toString()).toBe("lore://help/{tool}/{action}")
    expect(actionCall[2]).toMatchObject({ mimeType: "text/markdown" })

    const listed = await actionCall[1].listCallback({})
    expect(listed.resources).toHaveLength(HELP_RECIPES.length)
    expect(listed.resources).toContainEqual(
      expect.objectContaining({
        uri: "lore://help/lore-query/search",
        mimeType: "text/markdown",
      })
    )

    const recipeResult = (await actionCall[3](
      new URL("lore://help/lore-query/search"),
      { tool: "lore-query", action: "search" },
      {}
    )) as ResourceReadResult
    expect(recipeResult.contents[0]).toMatchObject({
      uri: "lore://help/lore-query/search",
      mimeType: "text/markdown",
    })
    expect(recipeResult.contents[0]?.text).toContain("# lore-query action='search'")
    expect(recipeResult.contents[0]?.text).toContain("```json")
  })

  it("renders one unique URI per recipe in the index", () => {
    const uris = HELP_RECIPES.map(helpResourceUri)
    expect(new Set(uris).size).toBe(HELP_RECIPES.length)

    const index = renderHelpIndex()
    for (const uri of uris) {
      expect(index).toContain(`\`${uri}\``)
    }
  })

  it("renders required safety guidance in the relevant recipes", () => {
    expect(rendered("lore-fact", "create")).toContain(
      "Requires provenance via sourceMemoryId"
    )
    expect(rendered("lore-task", "create")).toContain(
      "tangential or out-of-scope follow-up work"
    )
    expect(rendered("lore-procedure", "propose")).toContain(
      "approval still goes through lore-memory action='approve'"
    )
    expect(rendered("lore-pinned", "pin")).toContain(
      "Audience and mutability are rendering and audit metadata"
    )
    expect(rendered("lore-pinned", "list")).toContain(
      "Audience is rendering and audit metadata"
    )
  })

  it("renders search and ask as distinct retrieval recipes", () => {
    const search = rendered("lore-query", "search")
    const ask = rendered("lore-query", "ask")

    expect(search).toContain("mode")
    expect(search).toContain("Use lore-query action='ask' instead")
    expect(ask).toContain("structured facts and tasks")
    expect(ask).toContain("Use lore-query action='search' instead")
  })

  it("renders every recipe with markdown text and fenced JSON", () => {
    for (const recipe of HELP_RECIPES) {
      const text = renderHelpRecipe(recipe)
      expect(text).toContain(`# ${recipe.tool} action='${recipe.action}'`)
      expect(text).toContain("## Example Payload")
      expect(text).toContain("```json\n{")
      expect(text).toContain(
        "The tool schema and runtime validation remain authoritative"
      )
    }
  })
})

function rendered(tool: string, action: string): string {
  const recipe = findHelpRecipe(tool, action)
  if (!recipe) throw new Error(`missing recipe ${tool}/${action}`)
  return renderHelpRecipe(recipe)
}
