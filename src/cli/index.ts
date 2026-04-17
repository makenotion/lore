import { Command } from "commander"
import { initCommand } from "./commands/init.js"
import { authCommand } from "./commands/auth.js"
import { searchCommand } from "./commands/search.js"
import { mineCommand } from "./commands/mine.js"
import { statusCommand } from "./commands/status.js"
import { installCommand } from "./commands/install.js"
import { migrateCommand } from "./commands/migrate.js"

const program = new Command()

program.name("lore").description("AI memory system backed by Notion").version("0.1.0")

program.addCommand(initCommand)
program.addCommand(authCommand)
program.addCommand(searchCommand)
program.addCommand(mineCommand)
program.addCommand(statusCommand)
program.addCommand(installCommand)
program.addCommand(migrateCommand)

program.parse()
