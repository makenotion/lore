export function formatAuditEvents(events) {
  return events.map((event) => event.id).join(",")
}
