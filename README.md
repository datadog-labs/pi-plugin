# Datadog Pi Plugin

Query Datadog from the [Pi coding agent](https://pi.dev/). Ask about logs, metrics, traces, dashboards, monitors, and more.

## Getting started

Install the plugin, restart Pi, and open the connection screen:

```bash
pi install npm:@datadog/pi-plugin
```

```text
/datadog
```

Choose your Datadog site and complete browser sign-in. Pi verifies the organization and saves the connection. There's no profile name or default-setting step: your first connection becomes the default automatically.

Then ask a Datadog question:

```text
Show me error logs for the checkout service from the last hour.
```

Credentials are reused across projects, and tokens refresh silently. Ordinary queries never launch browser sign-in. If authorization expires or is revoked, open `/datadog` and choose **Sign in again**.

## One organization or several

With one saved connection, `/datadog` shows a simple connection menu. You don't need to manage profiles.

Choose **Connect another organization** to add another org, including one on the same Datadog site. Existing credentials and your default connection are preserved. Once you have multiple connections, `/datadog` shows a searchable organization picker:

- Type to search by organization, label, or domain.
- Use the arrow keys and Enter to switch this session's connection.
- Press Tab for connection details: toolsets, an optional label, defaults, sign-in, sign-out, or removal.
- Press Escape to close the screen without switching.

The connection picker marks the current organization, and tool results record their originating organization. Switching closes the interactive visualization panel; transcript screenshots remain associated with the old organization.

A switch applies to the current Pi session, not other running sessions. Resuming or branching a session restores its selection. **Use by default for new sessions** changes the global default; **Use for this project** writes a project selection instead. Neither retargets existing sessions. If a selected connection is removed or its configuration is invalid, the plugin stops rather than silently choosing another organization.

Switching doesn't erase earlier results from the conversation. Use separate Pi sessions if you don't want results from different organizations in the same model context.

## Toolsets and diagnostics

Use `/datadog toolsets`, or the connection screen, to configure toolsets for the selected organization. The existing searchable picker supports server defaults, all generally available toolsets, and explicitly selected preview toolsets.

The agent has three tools:

- `datadog` discovers and invokes MCP tools for the selected organization.
- `ddconfig` reports saved connection state; its `check` action probes the server without starting interactive sign-in, and its `switch` action moves the session to another saved connection, so the agent can compare orgs in one prompt.
- `ddtoolsets` manages toolsets for the selected connection.

Prompts also carry the Datadog MCP Server's instructions for the selected organization, such as skill and access guidance. Pi connects at the start of a prompt to read them and leaves them out if the server can't be reached within a few seconds.

`/datadog setup` and `/datadog configure` without arguments open the same connection screen for compatibility. Their old site/scope arguments and the separate `ddsetup` tool have been removed. Sign-in and adding organizations are user-controlled through `/datadog`; the agent can only switch between connections you've already saved.

## Visualization panel (macOS preview)

Start Pi with `DDVIZ_ENABLED=1` to enable ddviz (requires macOS 13+ and Xcode Command Line Tools). After generating a Datadog chart, press **Shift+Right Arrow** (Shift+→) in Pi's editor to show the interactive panel. This works in Apple Terminal.app without extra keyboard configuration and does not conflict with Pi's default bindings.

When the panel has focus, press **Escape** or **Cmd+W** to close it. Shift+Right Arrow is not intercepted there, so text selection in the panel remains available.

Run `/datadog ddviz` to check whether ddviz is enabled, supported, and available on this machine:

- **Machine prerequisites** — macOS, Xcode Command Line Tools, Swift
- **Installation** — the plugin's bundled files
- **Terminal** — inline-image protocol support
- **Runtime** — whether the visualization panel's processes are running
- **Connectivity** — reachability of the selected Datadog organization

Each failing check explains what to do about it. The command is read-only: it never starts the panel, changes the organization, signs in, or enables the feature. Not running is the normal steady state; the runtime starts on the first chart-producing tool call.

### Why Shift+Right Arrow?

The shortcut must work in Apple Terminal.app without extra configuration and avoid conflicts with Pi's default bindings, including those used only in pickers. Shift+Right Arrow meets both requirements: shifted arrows have distinct legacy terminal sequences, unlike Ctrl+Shift+letter combinations. Pi's editor does not use it for text selection, and the hint displays **Shift+→** to make the arrow key unambiguous. User-defined keybindings or other extensions can still introduce conflicts.

Alternatives tried or evaluated:

| Shortcut     | Why it was not retained                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl+Shift+O | Original binding. Terminal.app sends the same input as Ctrl+O, which Pi uses to expand/collapse tool output.                                             |
| Ctrl+R       | First replacement, tested locally. It works in the editor but triggers a startup conflict warning because Pi binds it to session renaming in the picker. |
| Alt/Option+O | Unused in Pi's defaults, but Terminal.app needs "Use Option as Meta key" enabled; otherwise Option+O types a character.                                  |
| Ctrl+Q       | Available in Pi's macOS defaults, but rejected because it suggests quitting rather than showing a panel.                                                 |
| F6           | Unused in Pi's defaults and supported by legacy terminals, but often requires Fn/Globe on Mac keyboards; a non-function-key shortcut was preferred.      |
| Ctrl+Space   | Can be intercepted by macOS input-source switching.                                                                                                      |
| Ctrl+\\      | Conventionally sends the terminal quit signal, so it has the same quit-related drawback as Ctrl+Q.                                                       |

## Storage and project overrides

The default state directory is `~/.pi/agent/datadog/`, following Pi's `PI_CODING_AGENT_DIR` override when set.

- `datadog.json` holds saved profile metadata and the default selection, not credentials.
- `datadog-oauth/profiles/<credential-id>/<domain>/credentials.json` holds a new OAuth grant. Credential IDs are opaque and don't depend on display labels.
- Pi session metadata holds the session's selected profile ID.
- A trusted project's `.pi/datadog.json` can select a saved profile with `{ "profileId": "<saved-id>" }` and optionally override `toolsets`. It can't redefine credentials or the destination server. These IDs refer to local saved connections; they're not portable team-wide aliases.

Existing `{ "domain": "...", "toolsets": "..." }` configs are imported automatically. Existing domain-based OAuth caches stay in place and are upgraded on write, rather than duplicating rotating refresh tokens. A working connection doesn't require another login merely because the plugin was upgraded. Legacy project overrides are imported when that trusted project is opened. A legacy project can't introduce a new custom MCP destination: connect that server explicitly through `/datadog` first.

Signing out clears that connection's locally stored credentials across Pi sessions on this device. It doesn't revoke the remote Datadog authorization or affect other saved orgs. Removing a connection also removes its saved metadata. Projects and sessions selecting it will need another selection.

## API keys and headless usage

To use API keys, set both variables before starting Pi:

```bash
export DD_API_KEY=your-api-key
export DD_APPLICATION_KEY=your-application-key
```

The connection screen offers **Use API keys from the environment** when both are available. This mode is saved on that connection; environment keys never override an explicitly saved OAuth connection. The variables provide one key pair per Pi process, not a different pair for each saved org. The authenticated org is still verified before tool execution.

Headless runs use a previously configured connection and either cached OAuth credentials or environment keys. They never wait for an interactive browser login. Configure/sign in using `/datadog` in TUI mode first. Existing environment-key configurations continue to work after import.

OAuth callbacks default to `http://localhost:19876/callback`. Set `DD_OAUTH_CALLBACK_PORT` before starting Pi if the port is occupied. Login cancellation releases the callback listener.

## Security boundaries

OAuth uses the official MCP SDK for discovery, client registration, PKCE, and token refresh. Before executing tools, the plugin verifies `datadog://mcp/whoami` against the saved organization UUID. Servers without this identity resource can't be used until verification is available.

Credential files use owner-only permissions on POSIX (`0600` files, `0700` directories), atomic writes, and cross-process locking. They're file-backed, not encrypted or stored in the OS keychain. Windows uses its filesystem ACL model. These measures don't isolate credentials from other processes running as your user.

Custom MCP domains require explicit confirmation during connection setup. Only connect to servers you trust. The plugin doesn't include credentials in its model-facing tool results or session metadata.

## Updating and support

After updating the package, run `/reload` in Pi. Connection changes don't require a restart.

- [Datadog MCP Server Documentation](https://docs.datadoghq.com/mcp_server/)
- [Pi Documentation](https://pi.dev/docs)

## Legal

See [NOTICE](NOTICE), [LICENSE-3rdparty.csv](LICENSE-3rdparty.csv), and the [Datadog Privacy Policy](https://www.datadoghq.com/legal/privacy/).
