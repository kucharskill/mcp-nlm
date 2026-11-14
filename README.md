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
It forwards MCP requests, results, notifications and server requests without mapping
tool names, arguments or schemas. On restart it replays the client's initialization
handshake, hiding only that internal handshake response.

Each client request selects an idle delay: `initialize` and `tools/list` select
one minute; all other requests select thirty minutes. The latest request wins.
The timer starts after outstanding requests finish. Notifications do not extend it.
Closing the client connection closes the upstream process.

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

Development: `npm run check`. Disposable experiments belong in the ignored `tmp/` directory.
Build and verify the npm archive: `npm run release:prepare`.
GitHub Releases publish to npm through Trusted Publishing (OIDC).

License: [MIT](LICENSE).
