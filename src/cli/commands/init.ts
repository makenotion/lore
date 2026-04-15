import { Command } from "commander"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { stringify as yamlStringify } from "yaml"
import { createClient } from "../../notion/client.js"
import { VaultManager } from "../../core/vault.js"
import { resolveToken } from "../../config.js"
import type { LoreConfig } from "../../types.js"

export const initCommand = new Command("init")
  .description("Initialize a Lore vault in a Notion page")
  .argument("<page-id>", "Notion page ID to use as the vault root")
  .option("--token <token>", "Notion integration token (or set LORE_NOTION_TOKEN)")
  .action(async (pageId: string, opts: { token?: string }) => {
    const token = opts.token ?? (await resolveToken())
    const client = createClient(token)
    const vault = new VaultManager(client, pageId)

    console.log("Creating Lore databases in Notion...")

    try {
      const result = await vault.init()
      console.log("Vault initialized successfully!")
      console.log(`  Projects DB: ${result.databases.projects}`)
      console.log(`  Topics DB:   ${result.databases.topics}`)
      console.log(`  Memories DB: ${result.databases.memories}`)
      console.log(`  Facts DB:    ${result.databases.facts}`)

      // Write .lore.yaml
      const config: LoreConfig = {
        vault: { pageId },
        projects: [],
        hooks: {
          autoSave: true,
          wakeUp: true,
          saveInterval: 5,
        },
      }

      const configPath = resolve(process.cwd(), ".lore.yaml")
      await writeFile(configPath, yamlStringify(config))
      console.log(`\nConfig written to ${configPath}`)
      console.log("\nNext steps:")
      console.log("  1. Add projects to .lore.yaml")
      console.log("  2. Add the MCP server to your AI assistant config")
      console.log("  3. Run `lore mine` to index project files")
    } catch (err) {
      if (err instanceof Error && err.message.includes("already initialized")) {
        console.log("Vault already exists at this page. Use `lore status` to check.")
      } else {
        console.error(
          "Failed to initialize vault:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    }
  })
