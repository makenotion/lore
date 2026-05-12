import { Command } from "commander"
import { initCommand } from "./commands/init.js"
import { authCommand } from "./commands/auth.js"
import { searchCommand } from "./commands/search.js"
import { mineCommand } from "./commands/mine.js"
import { inboxCommand } from "./commands/inbox.js"
import { statusCommand } from "./commands/status.js"
import { installCommand } from "./commands/install.js"
import { migrateCommand } from "./commands/migrate.js"
import { digestCommand } from "./commands/digest.js"
import { tasksCommand } from "./commands/tasks.js"
import { conflictsCommand } from "./commands/conflicts.js"
import { entitiesCommand } from "./commands/entities.js"
import { vaultCommand } from "./commands/vault.js"
import { evalCommand } from "./commands/eval.js"
import { promoteCommand } from "./commands/promote.js"
import { mcpCommand } from "./commands/mcp.js"
import { hooksCommand } from "./commands/hooks.js"

const program = new Command()

program.name("lore").description("AI memory system backed by Notion").version("0.13.1")

program.addCommand(initCommand)
program.addCommand(authCommand)
program.addCommand(searchCommand)
program.addCommand(mineCommand)
program.addCommand(inboxCommand)
program.addCommand(statusCommand)
program.addCommand(installCommand)
program.addCommand(migrateCommand)
program.addCommand(digestCommand)
program.addCommand(tasksCommand)
program.addCommand(conflictsCommand)
program.addCommand(entitiesCommand)
program.addCommand(vaultCommand)
program.addCommand(evalCommand)
program.addCommand(promoteCommand)
program.addCommand(mcpCommand)
program.addCommand(hooksCommand)

program.parse()
