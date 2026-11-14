# mcp-nlm

A small Node.js stdio proxy for `notebooklm-mcp-cli`. Requires Node.js 22+ and `uvx` on PATH.

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

Working directory: `<OS temp>/uvx/nlm`. NotebookLM data and browser profiles:
`<OS temp>/uvx/nlm/data`, overridable with `NOTEBOOKLM_MCP_CLI_PATH`.
The uv cache retains its existing configuration. Browser detection stays upstream's default.

The latest package is resolved when upstream starts, not while it is running.
Authentication uses the same data directory:

```sh
uvx --from notebooklm-mcp-cli@latest nlm login --storage file
```

Set `NOTEBOOKLM_MCP_CLI_PATH` to the data directory above before running login.
Data in the OS temporary directory can be removed by system cleanup.

Upstream process state (such as in-memory jobs) does not survive idle shutdown.
Capabilities and tool schemas belong to upstream and can change after an update;
reconnect the MCP client if an update changes its advertised capabilities.

Development: `npm run check`. Disposable experiments belong in the ignored `tmp/` directory.
