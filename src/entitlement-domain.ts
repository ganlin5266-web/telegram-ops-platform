import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "./db.js";
import { businessDate, stable } from "./platform-data-input.js";
import { parseAdapterDate } from "./platform-adapters.js";

export const metricRegistry = Object.freeze({
  deposit_amount: Object.freeze({
    key: "deposit_amount",
    displayName: "D日充值金额",
    canonicalField: "deposit",
    dataType: "numeric(28,6)",
    currencyRequired: true,
    nullableBehavior: "pending",
    operators: [">="],
    semantics: "source_reported_deposit",
  }),
});
export const dateInput = z.string().refine(businessDate);
export const timezoneInput = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });
export const amountInput = z.string().regex(/^\d{1,22}(?:\.\d{1,6})?$/);
export function decimalUnits(value: string): bigint {
  amountInput.parse(value);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}
export function canonicalAmount(value: string): string {
  const units = decimalUnits(value);
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, "0")}`;
}
export function calendarDay(value: string, offset: number): string {
  dateInput.parse(value);
  const d = new Date(value + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return dateInput.parse(d.toISOString().slice(0, 10));
}
export function dateInZone(now: Date, timezone: string): string {
  timezoneInput.parse(timezone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function wallInstant(
  date: string,
  time: string,
  timezone: string,
): string {
  dateInput.parse(date);
  timezoneInput.parse(timezone);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new DomainError("entitlement_cutoff_invalid", 400);
  try {
    return parseAdapterDate(`${date} ${time}:00`, "local", timezone);
  } catch {
    throw new DomainError("entitlement_wall_time_ambiguous", 400);
  }
}
export const ruleInput = z
  .object({
    platformId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    metric: z.literal("deposit_amount"),
    operator: z.literal(">="),
    currency: z.string().regex(/^[A-Z]{3}$/),
    sourceTimezone: timezoneInput,
    entitlementTimezone: timezoneInput,
    cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    effectiveFrom: dateInput,
    effectiveUntil: dateInput,
    mappingBatchId: z.uuid(),
    tiers: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
            name: z.string().trim().min(1).max(80),
            threshold: amountInput,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.effectiveUntil < r.effectiveFrom)
      ctx.addIssue({ code: "custom", message: "effective_dates_invalid" });
    if (new Set(r.tiers.map((t) => t.key)).size !== r.tiers.length)
      ctx.addIssue({ code: "custom", message: "tier_key_duplicate" });
    for (let i = 1; i < r.tiers.length; i++)
      if (
        decimalUnits(r.tiers[i]!.threshold) <=
        decimalUnits(r.tiers[i - 1]!.threshold)
      )
        ctx.addIssue({
          code: "custom",
          message: "tier_thresholds_not_increasing",
        });
  });
export type RuleInput = z.infer<typeof ruleInput>;
export function validateCalendar(rule: RuleInput) {
  // Bounded dated versions make every local cutoff (including DST transitions) verifiable before publication.
  let day = rule.effectiveFrom,
    count = 0;
  while (day <= rule.effectiveUntil) {
    if (++count > 366)
      throw new DomainError("entitlement_rule_range_too_large", 400);
    const cutoff = wallInstant(day, rule.cutoffTime, rule.sourceTimezone);
    const start = wallInstant(day, "00:00", rule.entitlementTimezone);
    const end = wallInstant(
      calendarDay(day, 1),
      "00:00",
      rule.entitlementTimezone,
    );
    if (cutoff < start || cutoff >= end)
      throw new DomainError("entitlement_cutoff_outside_window", 400);
    day = calendarDay(day, 1);
  }
}
export type Status = "pending" | "eligible" | "ineligible" | "review_required";
export type Decision = {
  status: Status;
  reasonCode: string;
  matchedTier: string | null;
};
export type EvaluationInput = {
  identityStatus: string | null;
  ruleAvailable: boolean;
  ruleConflict?: boolean;
  factPresent: boolean;
  completeness: string | null;
  conflicting?: boolean;
  metricAvailable: boolean;
  mappingCompatible: boolean;
  value: string | null;
  factCurrency: string | null;
  ruleCurrency: string | null;
  cutoffReached: boolean;
  tiers: { key: string; threshold: string }[];
};
export function decideEntitlement(i: EvaluationInput): Decision {
  const result = (
    status: Status,
    reasonCode: string,
    matchedTier: string | null = null,
  ): Decision => ({ status, reasonCode, matchedTier });
  if (i.identityStatus === "conflict")
    return result("review_required", "identity_conflict");
  if (i.identityStatus !== "verified")
    return result("pending", "waiting_for_identity");
  if (i.ruleConflict) return result("review_required", "rule_conflict");
  if (!i.ruleAvailable) return result("pending", "rule_not_available");
  if (i.conflicting || i.completeness === "conflicting")
    return result("review_required", "conflicting_data");
  if (!i.factPresent)
    return result(
      "pending",
      i.cutoffReached ? "stale_data" : "waiting_for_data",
    );
  if (i.completeness !== "complete")
    return result("pending", "incomplete_data");
  if (!i.metricAvailable || i.value === null)
    return result("pending", "metric_not_available");
  if (!i.mappingCompatible)
    return result("review_required", "mapping_semantics_conflict");
  if (i.factCurrency !== i.ruleCurrency)
    return result("review_required", "currency_mismatch");
  if (!amountInput.safeParse(i.value).success)
    return result("review_required", "invalid_metric_value");
  let selected: { key: string; threshold: string } | undefined;
  for (const tier of i.tiers)
    if (
      decimalUnits(i.value) >= decimalUnits(tier.threshold) &&
      (!selected ||
        decimalUnits(tier.threshold) > decimalUnits(selected.threshold))
    )
      selected = tier;
  return selected
    ? result("eligible", "eligible_threshold_met", selected.key)
    : result("ineligible", "threshold_not_met");
}
export const inputFingerprint = (input: unknown): string =>
  createHash("sha256").update(stable(input)).digest("hex");
