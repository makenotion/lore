# Team Rollout 0.10.0 Archive

> Status: Historical evidence for the completed 0.10.0 internal dogfood
> rollout. For current operator guidance, use
> [`docs/team-rollout.md`](../team-rollout.md).

This archive preserves the promotion criteria and telemetry note from the
completed ntn-first auth rollout. These items are not current release gates or
team-onboarding requirements.

## Dogfood Promotion Criteria

The release coordinator used these criteria before promoting 0.10.0 from
"internal dogfood" to "ready for general internal adoption":

- At least 2 internal teams had rolled out and had been on ntn-first auth
  for at least 1 week.
- No `[lore] partial-failure` lines tied to authentication appeared in the
  rollout teams' stderr logs over the rollout window.
- At least 1 engineer confirmed the multi-workspace flow
  (`NOTION_WORKSPACE_ID` env or `auth.workspaceId` config) worked as
  documented.
- At least 1 engineer hit a mid-session token expiry and the documented
  `lore auth --login` + bounded in-process retry worked. If the refreshed
  auth was unchanged or still rejected, the fallback restart recovery also
  worked.
- No regressions appeared in the existing test surface.
- No regressions appeared in the existing `lore status` output.

## Telemetry Note

The 0.10.0 rollout optionally considered one stderr line per `resolveAuth`
resolution, recording which source produced the token
(`source: env-notion-api-token` / `ntn-auth-json`) behind `LORE_DEBUG=1`.
That note was for release-coordinator visibility during the dogfood window
and is not a current onboarding requirement.
