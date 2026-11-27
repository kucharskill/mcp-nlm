# mcp-nlm

A small stdio proxy for [`notebooklm-mcp-cli`](https://github.com/jacob-bd/gemini-notebook-mcp-cli).
Requires Node.js 22+ and `uvx` on PATH. The proxy is distributed through npm;
uvx runs only the upstream NotebookLM server.

```sh
npx -y --prefer-online mcp-nlm@latest
npx -y --prefer-online mcp-nlm@latest --version
```

MCP client configuration:

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "mcp-nlm@latest"]
    }
  }
}
```

To run directly from a checkout:

```sh
node cli.js
```

The proxy launches `uvx --from notebooklm-mcp-cli@latest notebooklm-mcp` on demand.
It forwards tool requests, results, notifications and server requests without mapping
tool names, arguments or schemas. On restart it replays a legacy client's initialization
handshake, hiding only that internal handshake response. Modern MCP requests carry
their own metadata and do not receive an invented legacy handshake.

Discovery that needs upstream (`initialize`, `server/discover`, or catalog listing)
selects one minute of idle time; other forwarded requests select thirty minutes.
The latest forwarded request wins. Cache hits and local keep-alives do not start
upstream, change the delay, or reset the existing idle deadline.
The timer starts after outstanding requests finish. Notifications do not extend it.
Closing the client connection closes the upstream process.

## Local discovery and keep-alive

Legacy `ping` receives a local empty JSON-RPC result, including while startup or
another operation is pending. `ping` was removed in MCP 2026-07-28: a request that
declares a modern revision receives MethodNotFound locally, without waking upstream.

Replicas share discovery files in `<OS temp>/uvx/nlm/discovery/`. A fresh file can
answer legacy `initialize`, modern `server/discover`, and complete catalog requests
(`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`) without
starting Python or uvx. Descriptions, schemas, annotations, instructions and discovery
metadata are retained; tool results and session IDs are never cached. Paginated
requests/results and discovery containing session-specific fields bypass caching.

The filename is a SHA-256 hash of an unambiguous encoding of the actual upstream
command, arguments, effective working directory and full environment sorted by name.
Environment names are case-insensitive on Windows. `CODEX_TOOL_CALL_ID` is excluded
only from the hash; the original environment still goes to upstream. No environment
values, command arguments or credentials are written into cache records or logs.
Initialization contracts (protocol, client capabilities and options) are hashed
separately inside the record so incompatible clients do not reuse a negotiation.

Default TTL is **10 minutes**, recorded as `expiresAt` on each successful refresh;
reading a cache entry does not extend it. `MCP_NLM_CACHE_TTL_MS` overrides the TTL
in milliseconds (`0` disables caching). `MCP_NLM_CACHE_EXCLUDE_ENV` adds comma-separated
environment names to the key exclusions. Use exclusions only for fields that cannot
affect upstream behavior. Corrupt, old, expired or inaccessible entries are safe misses.
Writes use a short exclusive writer lock, restrictive file permissions and atomic
replacement. An invalidation generation prevents older in-flight responses from
restoring a catalog after a `list_changed` notification. Concurrent replicas may
each start upstream on a cold miss; there is no daemon or startup aggregator.

Catalog-change notifications and observed changes in upstream identity invalidate
the shared record. A restarted legacy backend must still match the client's negotiated
protocol and capabilities; otherwise the call fails with a reconnect instruction,
without running or retrying the original operation. An unobserved upstream update
can remain invisible until the cache expires or real work starts upstream.

One exception to response transparency is authentication recovery. When a tool
returns an explicit authentication error, the proxy calls upstream `refresh_auth`
once (concurrent failures for the same profile share the attempt). It preserves
the original result and appends a text block reporting whether refresh succeeded.
It never retries the original operation, changes the active profile, or starts an
interactive login. Explicit client calls to `refresh_auth` pass through unchanged.
Refresh has a sixty-second response timeout; expiry does not cancel upstream's
ongoing recovery. Upstream may launch its managed browser in the background.

Working directory: `<OS temp>/uvx/nlm`. NotebookLM data and browser profiles:
`<OS temp>/uvx/nlm/data`, overridable with `NOTEBOOKLM_MCP_CLI_PATH`.
The uv cache retains its existing configuration. Browser detection stays upstream's default.

The latest package is resolved when upstream starts, not while it is running.
Authentication uses the same data directory:

```sh
uvx --from notebooklm-mcp-cli@latest nlm login --storage file
```

Set `NOTEBOOKLM_MCP_CLI_PATH` to the data directory above before running login.
Set the same variable for the MCP client if you choose a different directory.
Check login with `nlm login --check` or explicitly refresh with `nlm auth refresh`,
using the same `uvx --from notebooklm-mcp-cli@latest` prefix and data directory.
Data in the OS temporary directory can be removed by system cleanup.

NotebookLM access uses an unofficial upstream integration and your Google account.
Account features, quotas and any subscription charges are controlled by Google.
This proxy adds no API service or per-request fee.

Upstream process state (such as in-memory jobs) does not survive idle shutdown.
Capabilities and tool schemas belong to upstream and can change after an update;
reconnect the MCP client if an update changes its advertised capabilities.

Development: `npm run check`. Disposable experiments belong in the ignored `.tmp/` directory.
Build and verify the npm archive: `npm run release:prepare`.
Verify the packed CLI, shared discovery in two processes and a safe fixture operation:
`node scripts/packed-smoke.mjs`. Automated tests and CI use local fixtures, without
NotebookLM accounts, paid requests or production operations.
GitHub Releases publish to npm through Trusted Publishing (OIDC).

License: [MIT](LICENSE).
