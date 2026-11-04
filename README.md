# opencode-account-info

A TUI plugin for OpenCode that adds a **Limits** section to the session sidebar,
pinned just above the working-directory footer, and a `/usage-forecast`
dialog with the full picture.

It shows the usage limits of the OpenCode Console workspace you are signed in
to. Under the section title, a dim caption reads **When your Go usage resets**,
then the three Go windows follow.

- **OpenCode Go** — the 5-hour, weekly, and monthly allowance, with the reset
  time and, when the current burn rate would exhaust one before it resets, how
  long it has left.
- **Console budgets** — what is left on each spend budget, when it resets, the
  daily burn rate, and the projected spend at reset.

## Where the numbers come from

The plugin calls the local OpenCode server:

```
GET /api/experimental/usage/limits
```

That endpoint is the same one the built-in `/usage` dialog and the `Limit`
sidebar section read. The server fetches the workspace budgets and the Go
allowance with the OpenCode Console credentials it already stores, so the plugin
needs no API key, no browser session, and never scrapes the Console page.

## Enable it

Clone it into OpenCode's plugin directory, where it is discovered automatically:

```sh
git clone https://github.com/xr1140/opencode-account-info \
  ~/.config/opencode/plugins/opencode-account-info
```

Or list any checkout in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/path/to/opencode_account_info"]
}
```

OpenCode watches the config and the plugin sources, so saving either reloads
the plugin without a restart. With the `cli.json` option, remove the entry to
disable it.

Alternatively, put the directory under `~/.config/opencode/plugins/` (or
`.opencode/plugins/` in a project) and it is discovered automatically. The
conventional entrypoint is `tui.tsx` at the directory root, which this folder
uses.

## Use it

- Open a session and look at the sidebar. Click the **Limits** header to
  collapse or expand it when it has more than three rows; click a row to open
  the details dialog.
- Run `/usage-forecast`, or pick **Show usage forecast** in the command palette
  (`Ctrl+P`).

The data refreshes every 60 seconds and after each turn.

## Files

| File | Purpose |
| --- | --- |
| `tui.tsx` | Plugin entrypoint: data loading, sidebar section, dialog, command |
| `forecast.ts` | Response types, window math, formatting |

## How the forecast works

For each window, the plugin assumes the spend seen so far continues at the same
rate:

```
rate      = used / (now - windowStart)
projected = rate * (resetsAt - windowStart)
emptyAt   = now + (limit - used) / rate
```

- Go windows are 5 hours, 7 days, and 30 days, matching the 5-hour 20%,
  weekly 50%, monthly 100% allowance.
- Console budgets reset monthly, so their window starts one calendar month
  before `resetsAt`.
- A window younger than a minute, or one with no spend yet, shows no forecast.
- The projection is linear. Bursty use, model changes, or shared budgets can
  make the real number differ; it is a rate, not a prediction.

## Limitations

- The section is mounted with `before: "sidebar.footer"`, so it is pinned
  above the working-directory path and branch, outside the scrolling content.
  If OpenCode's **Getting started** card is visible, it appears above that card
  too, since the card and the path share the footer slot.
- When you are not signed in to OpenCode Console the endpoint returns `null`
  and the section hides itself. The dialog says how to sign in.
- `budgets` is empty for service accounts, and on workspaces without spend
  budgets, so only the Go meters appear.
