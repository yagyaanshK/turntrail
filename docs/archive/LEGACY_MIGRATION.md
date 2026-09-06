# Legacy Migration Notes

Turntrail was developed locally under the working name Context Bridge before its public release.
Compatibility remains in place so those development installations do not lose their local data:

- Existing `.context-bridge/` project ledgers and `~/.context-bridge/` account stores are detected
  and used in place. New projects and account stores use `.turntrail/`.
- The old `context-bridge` executable remains an alias for `turntrail`.
- Existing `contextBridge.*` VS Code settings and command IDs remain supported. New configuration
  and commands use `turntrail.*`.
- Pre-release local VSIX builds used `yagyaanshK.context-bridge-vscode`. The public Marketplace
  extension ID is `turntrail.turntrail`.

No manual data migration is required. If both storage directories exist in the same location,
Turntrail uses `.turntrail/` and leaves `.context-bridge/` untouched.

These details are retained only for development-history and migration support. Context Bridge was
never a publicly launched product name.
