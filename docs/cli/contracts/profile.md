# The `profile` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore profile` owns profile distribution. See [`profiles.md`](../../profiles.md) for
resolution priority, install collision handling, allow-list behavior, and the
migration DSL.

Contracts:

- `profile list` prints the active profile and every built-in, local, and
  installed-external profile visible to the config root. Mark the active profile
  and shadowed lower-priority resolutions distinctly.
- `profile show <name[@version]>` prints manifest details. Bare names resolve
  only when exactly one version is discoverable.
- `profile validate <path>` exits non-zero with human-readable errors for
  reserved `extends`, removed or renamed core properties, reserved predicates,
  missing prompt files, or unsupported additive property types.
- `profile preview <name[@version]>` performs dry-run resolution and prints the
  effective profile and source bundle path.
- `profile install <path|git-url#sha>` stages, validates, computes manifest
  digest, surfaces collisions and shadowing, and writes or updates
  `profiles.lock.json`. Git installs must be pinned to a full commit SHA.
- `profile set <name@version>` pins `.lore.yaml profile:` only after verifying
  the selector resolves.
- `profile migrate <name@version>` is dry-run by default. Apply mode takes the
  migration lock, verifies every step post-write, and writes a per-vault ledger.
  Destructive migration steps are rejected.
