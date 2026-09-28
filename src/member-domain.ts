import { z } from "zod";
import { DomainError } from "./db.js";
import {
  decimalUnits,
  dateInput,
  timezoneInput,
  inputFingerprint,
} from "./entitlement-domain.js";
export const SOURCE_ORDER = [
  "platform_daily",
  "qualified_referral",
  "member_task",
  "daily_checkin",
] as const;
export type GrowthSource = (typeof SOURCE_ORDER)[number];
export const levelConfig = z
  .object({
    levels: z
      .array(
        z
          .object({
            key: z.string().regex(/^level_[1-5]$/),
            name: z.string().min(1).max(60),
            threshold: z.number().int().nonnegative().max(1000000000),
          })
          .strict(),
      )
      .length(5),
    grandfather: z.literal(true),
  })
  .strict()
  .superRefine((v, c) => {
    v.levels.forEach((l, i) => {
      if (
        l.key !== `level_${i + 1}` ||
        (!i && l.threshold !== 0) ||
        (i > 0 && l.threshold <= v.levels[i - 1]!.threshold)
      )
        c.addIssue({ code: "custom", message: "level_order_invalid" });
    });
  });
export const growthConfig = z
  .object({
    timezone: timezoneInput,
    cap: z.literal(350),
    priority: z.tuple([
      z.literal("platform_daily"),
      z.literal("qualified_referral"),
      z.literal("member_task"),
      z.literal("daily_checkin"),
    ]),
    checkin: z.literal(5),
    taskCap: z.literal(50),
    referral: z.literal(50),
    referralCap: z.literal(250),
  })
  .strict();
export const platformConfig = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: timezoneInput,
    metric: z.literal("deposit_amount"),
    tiers: z
      .array(
        z
          .object({
            threshold: z.string().regex(/^\d{1,22}(\.\d{1,6})?$/),
            growth: z.number().int().nonnegative().max(350),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    mappingBatchId: z.uuid(),
  })
  .strict()
  .superRefine((v, c) => {
    v.tiers.forEach((t, i) => {
      if (
        i &&
        (decimalUnits(t.threshold) <= decimalUnits(v.tiers[i - 1]!.threshold) ||
          t.growth < v.tiers[i - 1]!.growth)
      )
        c.addIssue({ code: "custom", message: "tier_order_invalid" });
    });
  });
export const versionInput = z
  .object({
    kind: z.enum(["level", "growth", "platform"]),
    platformId: z.uuid().nullable().default(null),
    effectiveFrom: dateInput,
    effectiveUntil: dateInput,
    config: z.unknown(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.effectiveUntil < v.effectiveFrom ||
      (v.kind === "platform") !== !!v.platformId
    )
      c.addIssue({ code: "custom", message: "rule_scope_invalid" });
  });
export const DEFAULT_LEVELS = {
  levels: [0, 500, 2000, 6000, 15000].map((threshold, i) => ({
    key: `level_${i + 1}`,
    name: ["Starter", "Active", "Gold", "Elite", "Legend"][i]!,
    threshold,
  })),
  grandfather: true as const,
};
export const defaultGrowth = (timezone: string) => ({
  timezone,
  cap: 350 as const,
  priority: [...SOURCE_ORDER],
  checkin: 5 as const,
  taskCap: 50 as const,
  referral: 50 as const,
  referralCap: 250 as const,
});
export const DEFAULT_TIERS = [20, 50, 100, 300, 500, 1000].map((v, i) => ({
  threshold: String(v),
  growth: [10, 20, 40, 70, 100, 150][i]!,
}));
export function validateConfig(kind: string, config: unknown) {
  return kind === "level"
    ? levelConfig.parse(config)
    : kind === "growth"
      ? growthConfig.parse(config)
      : platformConfig.parse(config);
}
export function platformGrowth(
  value: string,
  tiers: z.infer<typeof platformConfig>["tiers"],
) {
  let n = 0;
  for (const t of tiers)
    if (decimalUnits(value) >= decimalUnits(t.threshold)) n = t.growth;
  return n;
}
export function nextLevel(balance: bigint, current: number, config: unknown) {
  const { levels } = levelConfig.parse(config);
  return Math.max(
    current,
    ...levels
      .filter((l) => balance >= BigInt(l.threshold))
      .map((l) => Number(l.key.slice(6))),
  );
}
export type Candidate = {
  id: string;
  orderKey?: string;
  kind: GrowthSource;
  requested: number;
  occurredAt: string;
  status: string;
};
export function allocateDay(candidates: Candidate[]) {
  let left = 350;
  const caps: Record<GrowthSource, number> = {
    platform_daily: 350,
    qualified_referral: 250,
    member_task: 50,
    daily_checkin: 5,
  };
  const sorted = [...candidates].sort(
    (a, b) =>
      SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind) ||
      a.occurredAt.localeCompare(b.occurredAt) ||
      (a.orderKey ?? a.id).localeCompare(b.orderKey ?? b.id),
  );
  return sorted.map((c) => {
    if (
      !Number.isSafeInteger(c.requested) ||
      c.requested < 0 ||
      c.requested > 350 ||
      !SOURCE_ORDER.includes(c.kind)
    )
      throw new DomainError("growth_input_invalid", 400);
    const granted =
      c.status === "eligible" ? Math.min(c.requested, caps[c.kind], left) : 0;
    caps[c.kind] -= granted;
    left -= granted;
    return {
      ...c,
      granted,
      capApplied: c.status === "eligible" && granted < c.requested,
    };
  });
}
export { inputFingerprint };
