import { Command } from "commander"
import { readFile, readdir, stat } from "node:fs/promises"
import { resolve, relative, basename, extname, join } from "node:path"
import { initServices } from "../../services.js"

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".dockerfile",
  ".tf",
])

export const mineCommand = new Command("mine")
  .description("Index project files as memories")
  .argument("[path]", "Path to index (default: current directory)")
  .option("-p, --project <name>", "Target project name")
  .option("-t, --topic <name>", "Target topic name")
  .option("--pattern <glob>", "File glob pattern", "**/*")
  .option("--dry-run", "Preview files without indexing")
  .option("-n, --limit <n>", "Max files to index", "50")
  .action(
    async (
      targetPath: string | undefined,
      opts: {
        project?: string
        topic?: string
        pattern: string
        dryRun?: boolean
        limit: string
      }
    ) => {
      try {
        const services = await initServices()
        const dir = resolve(targetPath ?? ".")

        // Find files recursively
        const IGNORED_DIRS = new Set([
          "node_modules",
          "dist",
          "build",
          ".git",
          ".next",
          "__pycache__",
        ])
        const IGNORED_FILES = new Set([
          ".lore.yaml",
          "package-lock.json",
          "yarn.lock",
          "pnpm-lock.yaml",
        ])

        async function walk(dir: string, base: string): Promise<string[]> {
          const entries = await readdir(dir, { withFileTypes: true })
          const results: string[] = []
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (!IGNORED_DIRS.has(entry.name)) {
                results.push(
                  ...(await walk(join(dir, entry.name), join(base, entry.name)))
                )
              }
            } else if (!IGNORED_FILES.has(entry.name)) {
              results.push(join(base, entry.name))
            }
          }
          return results
        }

        const files = await walk(dir, "")

        // Filter to text files
        const textFiles = files
          .filter((f) => TEXT_EXTENSIONS.has(extname(f).toLowerCase()))
          .slice(0, parseInt(opts.limit, 10))

        if (textFiles.length === 0) {
          console.log("No indexable files found.")
          return
        }

        if (opts.dryRun) {
          console.log(`Would index ${textFiles.length} files:`)
          for (const f of textFiles) {
            console.log(`  ${f}`)
          }
          return
        }

        // Resolve project
        let projectId: string | undefined
        if (opts.project) {
          const found = await services.projects.findByName(opts.project)
          if (found) projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        // Resolve topic
        let topicId: string | undefined
        if (opts.topic && projectId) {
          const topic = await services.topics.getOrCreate(opts.topic, projectId)
          topicId = topic.id
        }

        console.log(`Indexing ${textFiles.length} files...`)

        const MAX_FILE_SIZE = 100 * 1024 // 100KB

        let indexed = 0
        for (const file of textFiles) {
          const fullPath = resolve(dir, file)
          const fileStat = await stat(fullPath)
          if (fileStat.size > MAX_FILE_SIZE) {
            console.log(
              `  Skipping ${file} (${(fileStat.size / 1024).toFixed(0)}KB > 100KB limit)`
            )
            continue
          }
          const content = await readFile(fullPath, "utf-8")
          const relPath = relative(services.configRoot, fullPath)

          await services.memories.create({
            title: `${basename(file)} — ${relPath}`,
            content: `# ${relPath}\n\n\`\`\`${extname(file).slice(1)}\n${content}\n\`\`\``,
            projectId,
            topicId,
            source: "file",
            tags: [extname(file).slice(1), "mined"],
          })

          indexed++
          if (indexed % 10 === 0) {
            console.log(`  ${indexed}/${textFiles.length} files indexed...`)
          }
        }

        console.log(`Done! Indexed ${indexed} files.`)
      } catch (err) {
        console.error("Mine failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
