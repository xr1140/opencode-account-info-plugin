import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import {
  budgetLeft,
  budgetScope,
  budgetStart,
  forecast,
  formatDollars,
  formatDuration,
  formatPercent,
  formatReset,
  GO_WINDOWS,
  percentOf,
  type Budget,
  type Forecast,
  type Meter,
  type UsageInfo,
} from "./forecast"

type Theme = Plugin.Context["theme"]

type UsageLimitsCall = (input: {
  location: { directory: string }
}) => Promise<{ location: { directory: string }; data: UsageInfo | null }>

type MeterRow = {
  label: string
  meter: Meter
  forecast?: Forecast
}

const REFRESH_SECONDS = 60

function levelColor(theme: Theme, percent: number, limited = false) {
  if (limited || percent >= 100) return theme.text.feedback.error.base
  if (percent >= 80) return theme.text.feedback.warning.base
  return theme.text.base
}

export default Plugin.define({
  id: "account-info.usage",
  setup(context) {
    const [info, setInfo] = createSignal<UsageInfo | null | undefined>(undefined)
    const [error, setError] = createSignal<string>()
    let alive = true
    let loading = false

    const load = async () => {
      if (loading) return
      loading = true
      try {
        const location = context.location ?? context.data.location.default()
        // `experimental.usage.limits` is the current name; older releases expose the same call as `usage.limits`.
        const client = context.client as unknown as {
          experimental?: { usage?: { limits?: UsageLimitsCall } }
          usage?: { limits?: UsageLimitsCall }
        }
        const limits = client.experimental?.usage?.limits ?? client.usage?.limits
        if (!limits) throw new Error("This OpenCode release does not expose the usage limits API")
        const response = await limits({ location: { directory: location.directory } })
        if (!alive) return
        setInfo(response.data)
        setError(undefined)
      } catch (cause) {
        if (!alive) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        loading = false
      }
    }

    const openDialog = () => {
      void load()
      context.ui.dialog.set({ size: "large" })
      context.ui.dialog.show(() => <UsageDialog context={context} info={info} error={error} />)
    }

    void load()
    const timer = setInterval(() => void load(), REFRESH_SECONDS * 1000)
    const stopSucceeded = context.data.on("session.execution.succeeded", () => void load())
    const stopFailed = context.data.on("session.step.failed", () => void load())

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "account-info.usage",
          title: "Show usage forecast",
          group: "Account",
          palette: true,
          slash: { name: "usage-forecast" },
          run: openDialog,
        },
      ],
    }))

    context.ui.slot({
      before: "sidebar.footer",
      render: () => <SidebarUsage context={context} info={info} onOpen={openDialog} />,
    })

    return async () => {
      alive = false
      clearInterval(timer)
      stopSucceeded()
      stopFailed()
    }
  },
})

function SidebarUsage(props: {
  context: Plugin.Context
  info: () => UsageInfo | null | undefined
  onOpen: () => void
}) {
  const theme = props.context.theme
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })

  const goRows = createMemo<MeterRow[]>(() => {
    const go = props.info()?.go
    if (!go) return []
    const now = Date.now()
    return GO_WINDOWS.flatMap((window) => {
      const meter = go[window.key]
      if (!meter) return []
      return [
        {
          label: window.label,
          meter,
          forecast: forecast(meter.percent, 100, meter.resetsAt - window.duration, meter.resetsAt, now),
        },
      ]
    })
  })

  const budgets = createMemo(() =>
    (props.info()?.budgets ?? []).toSorted((left, right) => budgetLeft(left) - budgetLeft(right)),
  )
  const shown = createMemo(() => budgets().slice(0, 2))
  const more = createMemo(() => budgets().length - shown().length)
  const rowCount = createMemo(() => goRows().length + shown().length + (more() > 0 ? 1 : 0))
  const open = () => view.open || rowCount() <= 3

  const summary = createMemo(() => {
    const parts: string[] = []
    const go = goRows()[0]
    if (go) parts.push(`${formatPercent(go.meter.percent)} ${go.label}`)
    const budget = budgets()[0]
    if (budget) parts.push(`${formatDollars(budgetLeft(budget))} left`)
    return parts.join(" · ")
  })

  return (
    <Show when={rowCount() > 0}>
      <box paddingBottom={1}>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (rowCount() <= 3) return
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((cause) => console.error("Failed to persist usage sidebar state", cause))
          }}
        >
          <Show when={rowCount() > 3}>
            <text fg={theme.text.base}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.base}>
            <b>Limits</b>
            <Show when={!open()}>
              <span style={{ fg: theme.text.muted }}> ({summary()})</span>
            </Show>
          </text>
        </box>
        <Show when={open() && goRows().length > 0}>
          <box paddingBottom={1}>
            <text fg={theme.text.muted} attributes={TextAttributes.DIM}>
              When your Go usage resets
            </text>
          </box>
        </Show>
        <Show when={open()}>
          <box gap={1}>
            <For each={goRows()}>{(row) => <MeterLine theme={theme} row={row} onOpen={props.onOpen} />}</For>
          </box>
          <For each={shown()}>
            {(budget) => <BudgetLine theme={theme} budget={budget} onOpen={props.onOpen} />}
          </For>
          <Show when={more() > 0}>
            <text fg={theme.text.muted} onMouseUp={props.onOpen}>
              +{more()} more {more() === 1 ? "budget" : "budgets"}
            </text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

function MeterLine(props: { theme: Theme; row: MeterRow; onOpen: () => void }) {
  const color = () => levelColor(props.theme, props.row.meter.percent, props.row.meter.limited)
  const emptyIn = () => {
    const at = props.row.forecast?.emptyAt
    return at === undefined ? undefined : formatDuration(at - Date.now())
  }

  return (
    <box onMouseUp={props.onOpen}>
      <box flexDirection="row" gap={1} minWidth={0}>
        <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
          <span style={{ fg: props.theme.text.muted }}>{props.row.label.padEnd(5)}</span>
          <span style={{ fg: color() }}>{formatPercent(props.row.meter.percent).padStart(4)}</span>
        </text>
        <text
          flexShrink={0}
          wrapMode="none"
          fg={props.row.meter.limited ? props.theme.text.feedback.error.base : props.theme.text.muted}
        >
          {props.row.meter.limited ? "limited" : formatReset(props.row.meter.resetsAt)}
        </text>
      </box>
      <Show when={emptyIn()}>
        {(value) => (
          <text fg={props.theme.text.muted} wrapMode="none" truncate>
            {"     "}
            {formatPercent(props.row.forecast?.perDay ?? 0).padStart(4)}/day · empty in {value()}
          </text>
        )}
      </Show>
    </box>
  )
}

function BudgetLine(props: { theme: Theme; budget: Budget; onOpen: () => void }) {
  const left = () => budgetLeft(props.budget)
  const percent = () => percentOf(props.budget.spent, props.budget.limit)
  const color = () => levelColor(props.theme, percent())
  const rate = createMemo(() =>
    forecast(props.budget.spent, props.budget.limit, budgetStart(props.budget.resetsAt), props.budget.resetsAt, Date.now()),
  )
  const emptyIn = () => {
    const at = rate()?.emptyAt
    return at === undefined ? undefined : formatDuration(at - Date.now())
  }

  return (
    <box onMouseUp={props.onOpen}>
      <text fg={props.theme.text.base} wrapMode="none" truncate>
        <span style={{ fg: color() }}>{formatDollars(left())} left</span>
        <span style={{ fg: props.theme.text.muted }}> · resets {formatReset(props.budget.resetsAt)}</span>
      </text>
      <Show when={rate()}>
        {(value) => (
          <text fg={props.theme.text.muted} wrapMode="none" truncate>
            {"  "}
            {formatDollars(value().perDay)}/day
            <Show when={emptyIn()}>
              {(when) => (
                <span style={{ fg: props.theme.text.feedback.warning.base }}> · empty in {when()}</span>
              )}
            </Show>
            <Show when={!emptyIn() && value().over}>
              <span style={{ fg: props.theme.text.feedback.warning.base }}>
                {" "}
                · {formatDollars(value().projected)} by reset
              </span>
            </Show>
          </text>
        )}
      </Show>
    </box>
  )
}

function UsageDialog(props: {
  context: Plugin.Context
  info: () => UsageInfo | null | undefined
  error: () => string | undefined
}) {
  const theme = props.context.theme
  const info = () => props.info()
  const budgets = createMemo(() =>
    (info()?.budgets ?? []).toSorted((left, right) => budgetLeft(left) - budgetLeft(right)),
  )

  return (
    <box padding={2} gap={1} width="100%">
      <text fg={theme.text.base}>
        <b>Usage forecast</b>
      </text>

      <Show when={info()}>
        {(value) => (
          <Show when={value().workspace.name}>
            {(name) => <text fg={theme.text.muted}>Workspace: {name()}</text>}
          </Show>
        )}
      </Show>

      <Show when={props.error()}>
        {(message) => (
          <box>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {message()}
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              The local OpenCode server reads these limits with your OpenCode Console sign-in.
            </text>
          </box>
        )}
      </Show>

      <Show when={info() === null}>
        <text fg={theme.text.muted} wrapMode="word">
          Sign in to OpenCode Console with /connect to see your workspace's usage limits.
        </text>
      </Show>

      <Show when={info() === undefined && !props.error()}>
        <text fg={theme.text.muted}>Loading…</text>
      </Show>

      <Show when={info()}>
        {(value) => (
          <box gap={1}>
            <Show when={value().go}>
              {(go) => (
                <box gap={1}>
                  <text fg={theme.text.base}>
                    <b>OpenCode Go</b>
                  </text>
                  <For each={GO_WINDOWS}>
                    {(window) => (
                      <MeterDetail
                        theme={theme}
                        label={window.label}
                        duration={window.duration}
                        meter={go()[window.key]}
                      />
                    )}
                  </For>
                </box>
              )}
            </Show>

            <Show when={budgets().length > 0} fallback={<text fg={theme.text.muted}>No spend budgets apply to you.</text>}>
              <box gap={1}>
                <text fg={theme.text.base}>
                  <b>Budgets</b>
                </text>
                <For each={budgets()}>
                  {(budget) => (
                    <BudgetDetail theme={theme} budget={budget} workspace={value().workspace.name} />
                  )}
                </For>
              </box>
            </Show>
          </box>
        )}
      </Show>

      <text fg={theme.text.muted}>Refreshes every {REFRESH_SECONDS}s and after each turn. /usage-forecast opens this.</text>
    </box>
  )
}

function MeterDetail(props: { theme: Theme; label: string; duration: number; meter: Meter }) {
  const now = Date.now()
  const color = levelColor(props.theme, props.meter.percent, props.meter.limited)
  const rate = forecast(props.meter.percent, 100, props.meter.resetsAt - props.duration, props.meter.resetsAt, now)

  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.text.muted}>{props.label.padEnd(6)}</text>
        <text fg={color}>{formatPercent(props.meter.percent).padStart(4)}</text>
        <Bar theme={props.theme} percent={props.meter.percent} color={color} />
        <text fg={props.theme.text.muted}>
          {props.meter.limited ? "limited" : `resets ${formatReset(props.meter.resetsAt, now)}`}
        </text>
      </box>
      <Show when={rate}>
        {(value) => (
          <text fg={props.theme.text.muted} wrapMode="word">
            {"       "}
            {formatPercent(value().perDay).padStart(4)}/day
            {value().over ? ` → ${formatPercent(value().projected)} by reset` : ""}
            {value().emptyAt ? ` · empty in ${formatDuration(value().emptyAt! - now)}` : ""}
          </text>
        )}
      </Show>
    </box>
  )
}

function BudgetDetail(props: { theme: Theme; budget: Budget; workspace?: string }) {
  const now = Date.now()
  const percent = percentOf(props.budget.spent, props.budget.limit)
  const color = levelColor(props.theme, percent)
  const rate = forecast(
    props.budget.spent,
    props.budget.limit,
    budgetStart(props.budget.resetsAt),
    props.budget.resetsAt,
    now,
  )

  return (
    <box>
      <text fg={props.theme.text.base}>
        <span style={{ fg: color }}>{formatDollars(budgetLeft(props.budget))} left</span>
        <span style={{ fg: props.theme.text.muted }}>
          {" "}
          of {formatDollars(props.budget.limit)} · resets {formatReset(props.budget.resetsAt, now)}
        </span>
      </text>
      <text fg={props.theme.text.muted} wrapMode="word">
        {budgetScope(props.budget, props.workspace)}
      </text>
      <Show when={rate}>
        {(value) => (
          <text fg={props.theme.text.muted} wrapMode="word">
            {formatDollars(value().perDay)}/day → {formatDollars(value().projected)} by reset
            {value().over ? " (over the limit)" : ""}
            {value().emptyAt ? ` · empty in ${formatDuration(value().emptyAt! - now)}` : ""}
          </text>
        )}
      </Show>
    </box>
  )
}

function Bar(props: { theme: Theme; percent: number; color: string }) {
  const filled = Math.max(0, Math.min(10, Math.round(props.percent / 10)))
  return (
    <text fg={props.color}>
      {"█".repeat(filled)}
      <span style={{ fg: props.theme.text.muted }}>{"░".repeat(10 - filled)}</span>
    </text>
  )
}
