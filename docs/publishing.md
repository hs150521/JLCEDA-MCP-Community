# Publishing the Community Bridge

This project publishes an unofficial community-maintained derivative of the
MCP Bridge from [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP).
Keep the upstream attribution and the non-official disclaimer in the extension
description and README for every release.

## Release checklist

1. Keep `mcp-bridge/extension.json.uuid` unchanged. JLCEDA groups later uploads
   into the same extension namespace by UUID.
2. Increment the versions in `mcp-bridge/extension.json`,
   `mcp-bridge/package.json`, and `mcp-server/package.json` as applicable.
3. Update `mcp-bridge/CHANGELOG.md` and verify the README describes installation,
   configuration, security assumptions, upstream attribution, and support.
4. Run:

   ```powershell
   cd mcp-server
   npm ci
   npm test

   cd ..\mcp-bridge
   npm ci
   npm run build
   ```

5. Install the generated `build/mcp-bridge-community-<version>.eext` in a clean
   JLCEDA Professional profile. Test connection, reconnect, multi-client
   selection, read-only tools, component placement, ordinary net labels, power
   flags, error handling, and upgrade from the previous version.
6. Create a GitHub release for the matching commit and attach the `.eext`, its
   SHA-256 checksum, and release notes. Do not publish from a dirty worktree.
7. Visit the [JLCEDA Extension Marketplace](https://jlc-ext.com/), open
   **Extension Management**, choose **Upload Extension**, and upload the tested
   `.eext` file. The first upload creates the namespace; later versions use the
   same UUID.
8. Review the generated marketplace page before submitting. The package must
   contain valid `name`, `uuid`, `displayName`, `description`, `version`,
   `license`, category, entry file, README, and a non-default 1:1 icon no larger
   than 5 MiB. Different extension UUIDs may not reuse the same `name`.
9. Submit for review. If rejected, address the marketplace notice and upload a
   new patch version; do not replace an already published artifact silently.

Official requirements:

- [JLCEDA extension marketplace guide](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)
- [JLCEDA extension manifest guide](https://prodocs.lceda.cn/cn/api/guide/extension-json.html)

## Naming and trademark

The marketplace display name is **MCP Bridge 社区版（非官方）**. The description
must continue to state that it is based on the upstream MCP Bridge and is not an
official JLCEDA plugin. The repository remains under Apache-2.0; retain the
repository LICENSE and upstream attribution when distributing source or binary
packages.
