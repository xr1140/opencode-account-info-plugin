// Shapes returned by GET /api/experimental/usage/limits (UsageLimits.Info).
// Kept structural so the plugin has no build-time dependency on @opencode/client.

export type Meter = {
  /** How much of the window's allowance is used, 0-100. */
  percent: number
  /** The window refuses requests until it resets. */
  limited: boolean
  resetsAt: number
}

export type GoAllowance = {
  rolling: Meter
  weekly: Meter
  monthly: Meter
}

export type BudgetModel = {
  providerID: string
  modelID: string
  name: string
  spent?: number
}

export type Budget = {
  id: string
  limit: number
  spent: number
  scope: "each" | "combined"
  per: "set" | "model"
  coverage: "all" | "models"
  models: BudgetModel[]
  vendors: string[]
  inputPriceAtLeast?: number
  picked: boolean
  shared: boolean
  resetsAt: number
}

export type UsageInfo = {
  workspace: { id: string; name?: string; usageURL: string }
  go?: GoAllowance
  budgets: Budget[]
}

export const HOUR = 3_600_000
const DAY = 24 * HOUR

/** OpenCode Go windows: 5-hour 20%, weekly 50%, monthly 100% of the monthly allowance. */
export const GO_WINDOWS = [
  { key: "rolling", label: "5h", duration: 5 * HOUR },
  { key: "weekly", label: "Week", duration: 7 * DAY },
  { key: "monthly", label: "Month", duration: 30 * DAY },
] as const

export type Forecast = {
  /** Usage per day at the rate seen so far. */
  perDay: number
  /** Usage the window would reach at its reset at this rate. */
  projected: number
  /** `projected` passes the limit. */
  over: boolean
  /** When the limit runs out before the reset, if it does. */
  emptyAt?: number
}

/**
 * Projects a window from its spend so far. The window is assumed to start at
 * `start` and reset at `resetsAt`; a window younger than a minute has no
 * meaningful rate and returns nothing.
 */
export function forecast(
  used: number,
  limit: number,
  start: number,
  resetsAt: number,
  now: number,
): Forecast | undefined {
  const total = resetsAt - start
  const elapsed = now - start
  if (used <= 0 || limit <= 0 || total <= 0 || elapsed < 60_000) return undefined
  // A clock skew or a stale window can put the start after now.
  if (elapsed > total * 1.5) return undefined
  const rate = used / elapsed
  const left = Math.max(0, limit - used)
  const emptyAt = rate > 0 && left > 0 ? now + left / rate : undefined
  return {
    perDay: rate * DAY,
    projected: rate * total,
    over: rate * total > limit,
    emptyAt: emptyAt !== undefined && emptyAt < resetsAt ? emptyAt : undefined,
  }
}

/** Start of the month a monthly budget resets at, one calendar month earlier. */
export function budgetStart(resetsAt: number) {
  const start = new Date(resetsAt)
  start.setMonth(start.getMonth() - 1)
  return start.getTime()
}

export function budgetLeft(budget: Budget) {
  return Math.max(0, budget.limit - budget.spent)
}

export function percentOf(used: number, limit: number) {
  if (limit <= 0) return 100
  return Math.max(0, Math.min(100, (used / limit) * 100))
}

export function formatPercent(value: number) {
  return `${Math.round(value)}%`
}

/** Dollars as limits read: whole amounts without cents, and a sliver as "<$0.01". */
export function formatDollars(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/** A reset time: the clock time today, the weekday this week, otherwise the date. */
export function formatReset(at: number, now = Date.now()) {
  const date = new Date(at)
  // ICU puts a narrow no-break space before AM/PM, which terminals may draw at the wrong width.
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ")
  if (date.toDateString() === new Date(now).toDateString()) return time
  const days = (at - now) / DAY
  if (days > 0 && days < 7) {
    const weekday = date.toLocaleDateString("en-US", { weekday: "short" })
    return `${weekday} ${time}`
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** A duration as the sidebar reads it: minutes under an hour, then hours, then days. */
export function formatDuration(ms: number) {
  if (ms <= 0) return "now"
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A short description of who spends from a budget. */
export function budgetScope(budget: Budget, workspace: string | undefined) {
  const who = budget.scope === "each" ? "Only you" : budget.shared ? `Shared in ${workspace ?? "the workspace"}` : "You and others"
  if (budget.coverage === "all") return `${who} · all models`
  if (budget.models.length > 0) {
    const names = budget.models.map((model) => model.name)
    const shown = names.slice(0, 2).join(", ")
    return `${who} · ${names.length > 2 ? `${shown} +${names.length - 2}` : shown}`
  }
  if (budget.vendors.length > 0) return `${who} · ${budget.vendors.join(", ")}`
  if (budget.inputPriceAtLeast !== undefined)
    return `${who} · models over ${formatDollars(budget.inputPriceAtLeast)} per 1M`
  return who
}
