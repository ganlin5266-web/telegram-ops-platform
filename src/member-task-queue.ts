import type { Queryable } from "./db.js";
export async function queueGrowthSourceChange(
  tx: Queryable,
  brandId: string,
  platformId: string,
  eventKey: string,
  date?: string,
  userId?: string,
  botId?: string,
) {
  if (process.env.MEMBER_GROWTH_ENABLED !== "true") return;
  const rows = (
    await tx.query(
      `SELECT DISTINCT i.bot_id,i.user_id,f.business_date::text FROM platform_identities i JOIN platform_accounts a ON a.brand_id=i.brand_id AND a.platform_id=i.platform_id AND a.platform_uid=i.platform_uid JOIN platform_user_daily_facts f ON f.account_id=a.id WHERE i.brand_id=$1 AND i.platform_id=$2 AND ($3::date IS NULL OR f.business_date=$3::date) AND ($4::uuid IS NULL OR i.user_id=$4) AND ($5::uuid IS NULL OR i.bot_id=$5)`,
      [brandId, platformId, date ?? null, userId ?? null, botId ?? null],
    )
  ).rows;
  for (const r of rows)
    await tx.query(
      `INSERT INTO growth_evaluation_tasks(brand_id,bot_id,user_id,platform_id,source_business_date,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [brandId, r.bot_id, r.user_id, platformId, r.business_date, eventKey],
    );
}
