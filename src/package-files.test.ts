import { access, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

type PackageJson = {
  files?: string[]
}

const ALWAYS_PACKED_FILES = ["LICENSE", "README.md", "package.json"]
const INLINE_README_SUPPORT_FILES = [".lore.example.yaml"]

function packageEntryCoversFile(entry: string, file: string): boolean {
  const normalizedEntry = entry.replace(/\/+$/, "")

  return normalizedEntry === file || file.startsWith(`${normalizedEntry}/`)
}

function isPackedFile(file: string, packageFiles: readonly string[]): boolean {
  return (
    ALWAYS_PACKED_FILES.includes(file) ||
    packageFiles.some((entry) => packageEntryCoversFile(entry, file))
  )
}

function normalizeLocalMarkdownLink(href: string): string | undefined {
  const trimmed = href.trim()

  if (trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return undefined
  }

  const withoutFragment = trimmed.split("#", 1)[0]?.split("?", 1)[0]
  if (!withoutFragment || withoutFragment.startsWith("/")) {
    return undefined
  }

  return decodeURI(withoutFragment)
}

function extractReadmeLocalLinks(readme: string): string[] {
  const localLinks = new Set<string>()
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g

  for (const match of readme.matchAll(markdownLinkPattern)) {
    const localLink = normalizeLocalMarkdownLink(match[1])
    if (localLink) {
      localLinks.add(localLink)
    }
  }

  return [...localLinks].sort()
}

describe("package files", () => {
  it("packs local files referenced by README support flows", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf-8")) as PackageJson
    const packageFiles = packageJson.files ?? []

    const readme = await readFile("README.md", "utf-8")
    const readmeSupportFiles = [
      ...new Set([...extractReadmeLocalLinks(readme), ...INLINE_README_SUPPORT_FILES]),
    ].sort()

    const missingReferences: string[] = []
    for (const file of readmeSupportFiles) {
      await access(file).catch(() => {
        missingReferences.push(file)
      })
    }

    expect(missingReferences).toEqual([])

    const unpackedReferences = readmeSupportFiles.filter(
      (file) => !isPackedFile(file, packageFiles)
    )
    expect(unpackedReferences).toEqual([])
  })
})
