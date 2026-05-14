import { Command } from "commander"
import { initCommand } from "./commands/init.js"
import { authCommand } from "./commands/auth.js"
import { searchCommand } from "./commands/search.js"
import { mineCommand } from "./commands/mine.js"
import { inboxCommand } from "./commands/inbox.js"
import { pinnedCommand } from "./commands/pinned.js"
import { statusCommand } from "./commands/status.js"
import { installCommand } from "./commands/install.js"
import { migrateCommand } from "./commands/migrate.js"
import { digestCommand } from "./commands/digest.js"
import { tasksCommand } from "./commands/tasks.js"
import { conflictsCommand } from "./commands/conflicts.js"
import { debtCommand } from "./commands/debt.js"
import { proceduresCommand } from "./commands/procedures.js"
import { entitiesCommand } from "./commands/entities.js"
import { vaultCommand } from "./commands/vault.js"
import { evalCommand } from "./commands/eval.js"
import { promoteCommand } from "./commands/promote.js"
import { mcpCommand } from "./commands/mcp.js"
import { hooksCommand } from "./commands/hooks.js"
import { profileCommand } from "./commands/profile.js"

const program = new Command()

program.name("lore").description("AI memory system backed by Notion").version("0.14.0")

program.addCommand(initCommand)
program.addCommand(authCommand)
program.addCommand(searchCommand)
program.addCommand(mineCommand)
program.addCommand(inboxCommand)
program.addCommand(pinnedCommand)
program.addCommand(statusCommand)
program.addCommand(installCommand)
program.addCommand(migrateCommand)
program.addCommand(digestCommand)
program.addCommand(tasksCommand)
program.addCommand(conflictsCommand)
program.addCommand(debtCommand)
program.addCommand(proceduresCommand)
program.addCommand(entitiesCommand)
program.addCommand(vaultCommand)
program.addCommand(evalCommand)
program.addCommand(promoteCommand)
program.addCommand(mcpCommand)
program.addCommand(hooksCommand)
program.addCommand(profileCommand)

program.parse()
