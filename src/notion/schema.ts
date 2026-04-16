/**
 * Notion database property schemas for Lore's four databases.
 *
 * These definitions are used by setup.ts to create databases and by
 * core operations to read/write property values.
 */

import type { CreatePageParameters } from "@notionhq/client"

// ---------------------------------------------------------------------------
// Shared types for convenience
// ---------------------------------------------------------------------------

type PageProperties = CreatePageParameters["properties"]

/**
 * Property configuration for database creation.
 * Uses the new initial_data_source.properties shape.
 */
type PropertyConfig = Record<string, Record<string, unknown>>

// ---------------------------------------------------------------------------
// Projects Database
// ---------------------------------------------------------------------------

export const PROJECTS_DB_TITLE = "Projects"
export const PROJECTS_DB_ICON = "🗂️"

export const projectsProperties: PropertyConfig = {
  Name: { title: {} },
  Type: {
    select: {
      options: [
        { name: "project", color: "blue" },
        { name: "person", color: "green" },
        { name: "agent", color: "purple" },
      ],
    },
  },
  Path: { rich_text: {} },
  Status: {
    select: {
      options: [
        { name: "active", color: "green" },
        { name: "archived", color: "gray" },
      ],
    },
  },
  Description: { rich_text: {} },
}

// ---------------------------------------------------------------------------
// Topics Database
// ---------------------------------------------------------------------------

export const TOPICS_DB_TITLE = "Topics"
export const TOPICS_DB_ICON = "📑"

export function topicsProperties(projectsDbId: string): PropertyConfig {
  return {
    Name: { title: {} },
    Project: {
      relation: {
        single_property: {},
        data_source_id: projectsDbId,
      },
    },
    Description: { rich_text: {} },
  }
}

// ---------------------------------------------------------------------------
// Memories Database
// ---------------------------------------------------------------------------

export const MEMORIES_DB_TITLE = "Memories"
export const MEMORIES_DB_ICON = "🧠"

export function memoriesProperties(
  projectsDbId: string,
  topicsDbId: string
): PropertyConfig {
  return {
    Title: { title: {} },
    Project: {
      relation: {
        single_property: {},
        data_source_id: projectsDbId,
      },
    },
    Topic: {
      relation: {
        single_property: {},
        data_source_id: topicsDbId,
      },
    },
    Source: {
      select: {
        options: [
          { name: "conversation", color: "blue" },
          { name: "file", color: "yellow" },
          { name: "manual", color: "green" },
          { name: "agent_diary", color: "purple" },
          { name: "digest", color: "brown" },
        ],
      },
    },
    Author: { rich_text: {} },
    Agent: { rich_text: {} },
    Tags: { multi_select: { options: [] } },
    Session: { rich_text: {} },
  }
}

// ---------------------------------------------------------------------------
// Facts Database (Knowledge Graph)
// ---------------------------------------------------------------------------

export const FACTS_DB_TITLE = "Facts"
export const FACTS_DB_ICON = "🔗"

export function factsProperties(
  projectsDbId: string,
  memoriesDbId: string
): PropertyConfig {
  return {
    Subject: { title: {} },
    Predicate: {
      select: {
        options: [
          { name: "is_a", color: "blue" },
          { name: "has_a", color: "green" },
          { name: "uses", color: "yellow" },
          { name: "depends_on", color: "orange" },
          { name: "related_to", color: "pink" },
          { name: "created_by", color: "purple" },
          { name: "owned_by", color: "red" },
          { name: "replaces", color: "gray" },
          { name: "extends", color: "brown" },
          { name: "conflicts_with", color: "red" },
          { name: "needs_action", color: "red" },
          { name: "waiting_on", color: "orange" },
          { name: "blocked_by", color: "red" },
        ],
      },
    },
    Object: { rich_text: {} },
    Project: {
      relation: {
        single_property: {},
        data_source_id: projectsDbId,
      },
    },
    "Valid From": { date: {} },
    "Valid Until": { date: {} },
    "Review By": { date: {} },
    Source: {
      relation: {
        single_property: {},
        data_source_id: memoriesDbId,
      },
    },
    Confidence: {
      select: {
        options: [
          { name: "certain", color: "green" },
          { name: "likely", color: "yellow" },
          { name: "speculative", color: "orange" },
        ],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Property builder helpers
// ---------------------------------------------------------------------------

export function buildProjectProps(input: {
  name: string
  type?: string
  path?: string
  description?: string
}): PageProperties {
  const props: PageProperties = {
    Name: { title: [{ text: { content: input.name } }] },
  }
  if (input.type) {
    props["Type"] = { select: { name: input.type } }
  }
  if (input.path) {
    props["Path"] = { rich_text: [{ text: { content: input.path } }] }
  }
  if (input.description) {
    props["Description"] = {
      rich_text: [{ text: { content: input.description } }],
    }
  }
  props["Status"] = { select: { name: "active" } }
  return props
}

export function buildTopicProps(input: {
  name: string
  projectId: string
  description?: string
}): PageProperties {
  const props: PageProperties = {
    Name: { title: [{ text: { content: input.name } }] },
    Project: { relation: [{ id: input.projectId }] },
  }
  if (input.description) {
    props["Description"] = {
      rich_text: [{ text: { content: input.description } }],
    }
  }
  return props
}

export function buildMemoryProps(input: {
  title: string
  projectIds?: string[]
  topicId?: string
  source?: string
  author?: string
  agent?: string
  tags?: string[]
  session?: string
}): PageProperties {
  const props: PageProperties = {
    Title: { title: [{ text: { content: input.title } }] },
  }
  if (input.projectIds?.length) {
    props["Project"] = { relation: input.projectIds.map((id) => ({ id })) }
  }
  if (input.topicId) {
    props["Topic"] = { relation: [{ id: input.topicId }] }
  }
  if (input.source) {
    props["Source"] = { select: { name: input.source } }
  }
  if (input.author) {
    props["Author"] = { rich_text: [{ text: { content: input.author } }] }
  }
  if (input.agent) {
    props["Agent"] = { rich_text: [{ text: { content: input.agent } }] }
  }
  if (input.tags?.length) {
    props["Tags"] = {
      multi_select: input.tags.map((t) => ({ name: t })),
    }
  }
  if (input.session) {
    props["Session"] = { rich_text: [{ text: { content: input.session } }] }
  }
  return props
}

export function buildFactProps(input: {
  subject: string
  predicate: string
  object: string
  projectIds?: string[]
  validFrom?: string
  reviewBy?: string
  sourceMemoryId?: string
  confidence?: string
}): PageProperties {
  const props: PageProperties = {
    Subject: { title: [{ text: { content: input.subject } }] },
    Predicate: { select: { name: input.predicate } },
    Object: { rich_text: [{ text: { content: input.object } }] },
  }
  if (input.projectIds?.length) {
    props["Project"] = { relation: input.projectIds.map((id) => ({ id })) }
  }
  if (input.validFrom) {
    props["Valid From"] = { date: { start: input.validFrom } }
  }
  if (input.reviewBy) {
    props["Review By"] = { date: { start: input.reviewBy } }
  }
  if (input.sourceMemoryId) {
    props["Source"] = { relation: [{ id: input.sourceMemoryId }] }
  }
  if (input.confidence) {
    props["Confidence"] = { select: { name: input.confidence } }
  }
  return props
}
