**This plugin is currently in Preview.**

# Datadog Pi Plugin

Query your Datadog data directly from the [Pi coding agent](https://pi.dev/) using natural language. Ask about logs, metrics, traces, dashboards, monitors, and more.

## What you need

- A [Datadog](https://www.datadoghq.com/) account
- [Pi](https://pi.dev/) installed (`npm i -g @earendil-works/pi-coding-agent`)

## Why this plugin looks different

Pi does not have built-in MCP support — it is intentionally minimal. This plugin ships as a Pi **extension** that talks directly to the Datadog MCP server, using the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) for the wire protocol and OAuth. The extension registers four tools the agent can use:

- `datadog` — proxy tool the agent uses to list and invoke Datadog MCP tools on demand (token-efficient: one tool definition regardless of how many Datadog tools exist server-side)
- `ddsetup`, `ddconfig`, `ddtoolsets` — manage the connection (site, toolsets, troubleshooting)

## Getting started

**1. Install the plugin** with Pi's package manager:

```bash
pi install npm:@datadog/pi-plugin
```

This adds the package to Pi's global settings and installs the plugin plus its runtime dependencies (including the MCP SDK) into Pi's npm package cache. Restart Pi after install.

**2. Start Pi** in your project:

```bash
pi
```

**3. Configure your Datadog site** by asking any Datadog question — the agent will run `ddsetup` automatically — or invoke it directly:

```
Run the ddsetup tool with site us1
```

**4. Sign in to Datadog** when the agent next calls the `datadog` tool. Your browser will open to the Datadog sign-in page; once you authorize, control returns to Pi and your tokens are cached globally at `~/.pi/agent/datadog/datadog-oauth/<domain>/`. The plugin creates that cache with owner-only permissions. Sign-in is shared across all your projects (per domain), so you authorize once. Subsequent calls reuse the cached tokens and refresh automatically when they expire.

## Using the plugin

Just ask the agent anything about your Datadog data:

```
Show me error logs from the last hour
```

```
What monitors are currently alerting?
```

```
Find traces for service "api-gateway" with latency > 500ms
```

```
List my dashboards
```

The agent will call the `datadog` tool with `{ "list": true }` first to discover available tools, then invoke the right one with arguments.

## Can't connect?

**Never connected before?** Tell the agent to run `ddsetup`. It will configure the Datadog MCP domain globally at `~/.pi/agent/datadog/datadog.json`.

**Was working before but stopped?** Tell the agent to run `ddconfig` with the troubleshoot action. The most common cause is an expired sign-in — call the `datadog` tool with `{ "list": true }` to trigger a fresh sign-in flow.

## Changing settings

The plugin provides tools the agent can use to manage configuration:

- `ddconfig` — change your Datadog site or view connection details
- `ddtoolsets` — enable or disable groups of tools

In Pi TUI mode, these tools can use interactive pickers: omit `site` when running `ddsetup` or `ddconfig` with `action: "change-site"` to choose from the known Datadog sites, and run `ddtoolsets` with `action: "configure"` to open the toolset picker. The picker also supports the `all` meta-toolset, which enables every generally available Datadog MCP toolset; preview toolsets still need to be selected explicitly.

## Advanced usage

### API key authentication (for headless / SSH / CI)

If your terminal can't open a browser, you can skip OAuth by setting both Datadog credentials in your shell before starting Pi:

```bash
export DD_API_KEY=your-api-key
export DD_APPLICATION_KEY=your-application-key
pi
```

When both are set, the plugin uses them as request headers and skips the OAuth flow entirely. Run `ddconfig` to see which auth mode is active in your current session.

### Callback port

By default OAuth callbacks come back on `http://localhost:19876/callback`. Override the port with `DD_OAUTH_CALLBACK_PORT` if `19876` conflicts with another tool.

### Configuration storage and per-project overrides

`pi install npm:@datadog/pi-plugin` writes the package entry to Pi's global settings (`~/.pi/agent/settings.json`) and installs the npm package under Pi's package cache (`~/.pi/agent/npm/`). By default the plugin keeps its config (`datadog.json`) and OAuth tokens (`datadog-oauth/<domain>/`) under `~/.pi/agent/datadog/`, so your setup and sign-in follow you across every project — you configure and authorize once. The agent dir honors `PI_CODING_AGENT_DIR` if you've overridden it.

If a single repo needs a different Datadog site than your global default, create a project override: run `ddsetup` with scope `project` (or place a `.pi/datadog.json` in the repo). When that file is present it wins for that directory, and `ddconfig`/`ddtoolsets` changes made there stay project-local. OAuth tokens remain global per domain regardless of scope, so a project override never forces a re-login.

### Reloading after changes

After updates (`pi install npm:@datadog/pi-plugin@latest` or local edits), run `/reload` inside Pi to pick up the changes without a full restart.

## Good to know

- Authentication is via OAuth 2.1 + PKCE by default. The MCP SDK handles RFC 9728 discovery, RFC 7591 dynamic client registration, the callback flow, and token refresh.
- Pi does not currently expose a secure extension credential store, so OAuth persistence is file-backed. The plugin stores OAuth artifacts under `~/.pi/agent/datadog/datadog-oauth/`, creates OAuth directories with `0700` permissions, and writes artifact files with `0600` permissions.
- No Datadog credentials are sent to the AI model provider — they are only sent in Datadog MCP HTTP request headers.

## Support

- [Datadog MCP Server Documentation](https://docs.datadoghq.com/mcp_server/)
- [Pi Documentation](https://pi.dev/docs)

## Legal

See the [NOTICE](NOTICE) and [LICENSE-3rdparty.csv](LICENSE-3rdparty.csv) files included with this plugin.

For details on how Datadog handles your data, see the [Datadog Privacy Policy](https://www.datadoghq.com/legal/privacy).
