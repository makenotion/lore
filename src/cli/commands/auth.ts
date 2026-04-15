import { Command } from "commander"
import { loadCredentials, runOAuthFlow } from "../../auth/oauth.js"

export const authCommand = new Command("auth")
  .description("Authenticate with Notion via OAuth or check token status")
  .option("--login", "Start the OAuth browser login flow")
  .option("--status", "Check authentication status (default)")
  .action(async (opts: { login?: boolean; status?: boolean }) => {
    if (opts.login) {
      await login()
    } else {
      await status()
    }
  })

async function login(): Promise<void> {
  const clientId = process.env["LORE_OAUTH_CLIENT_ID"]
  const clientSecret = process.env["LORE_OAUTH_CLIENT_SECRET"]

  if (!clientId || !clientSecret) {
    console.error("OAuth client credentials not configured.")
    console.error("")
    console.error("Set these environment variables:")
    console.error("  LORE_OAUTH_CLIENT_ID=<your integration's OAuth client ID>")
    console.error("  LORE_OAUTH_CLIENT_SECRET=<your integration's OAuth client secret>")
    console.error("")
    console.error("Create a public integration at:")
    console.error("  https://www.notion.so/profile/integrations")
    process.exit(1)
  }

  try {
    const credentials = await runOAuthFlow({ clientId, clientSecret })
    console.log("Authenticated successfully!")
    console.log(`  Workspace: ${credentials.workspace_name ?? credentials.workspace_id}`)
    console.log(`  Credentials saved to ~/.lore/credentials.json`)
  } catch (err) {
    console.error("Authentication failed:", err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

async function status(): Promise<void> {
  // Check all auth sources in priority order
  const envToken = process.env["LORE_NOTION_TOKEN"]
  if (envToken) {
    console.log("Auth method: environment variable (LORE_NOTION_TOKEN)")
    console.log(`Token: configured (${envToken.length} characters)`)
    return
  }

  const creds = await loadCredentials()
  if (creds) {
    console.log("Auth method: OAuth")
    console.log(`  Workspace: ${creds.workspace_name ?? creds.workspace_id}`)
    console.log(`  Authorized: ${creds.created_at.split("T")[0]}`)
    return
  }

  console.log("Not authenticated.")
  console.log("")
  console.log("Options:")
  console.log("  lore auth --login            Authenticate via OAuth (opens browser)")
  console.log("  export LORE_NOTION_TOKEN=...  Set an integration token")
}
