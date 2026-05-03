// The agent should rewrite this so the field names are snake_case
// (the project's logging convention). Pre-existing camelCase keys are
// the bug the agent must fix.
export function logEvent(name, payload) {
  console.log(JSON.stringify({ eventName: name, payload }))
}
