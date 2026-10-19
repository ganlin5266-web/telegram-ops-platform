import { useEffect, useRef, useState } from "react";
import type { MiniClient, RedemptionReveal, RedemptionTier } from "./client";
import type { Key, Locale } from "./i18n";
import { formatPoints } from "./i18n";

export default function RedemptionCentre({
  client,
  locale,
  t,
  onChanged,
  recoverId,
}: {
  client: MiniClient;
  locale: Locale;
  t: (key: Key, values?: Record<string, string>) => string;
  onChanged: () => Promise<unknown>;
  recoverId?: string;
}) {
  const [tiers, setTiers] = useState<RedemptionTier[]>([]);
  const [reveal, setReveal] = useState<RedemptionReveal>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    let live = true;
    client
      .redemptionTiers()
      .then((r) => live && setTiers(r.items))
      .catch(() => live && setNotice(t("request")));
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => {
    if (!recoverId) return;
    let live = true;
    setBusy(true);
    setNotice("");
    client
      .redemptionCode(recoverId)
      .then((r) => live && setReveal(r))
      .catch(() => live && setNotice(t("request")))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [client, recoverId]);
  const redeem = async (tier: RedemptionTier) => {
    if (!window.confirm(t("redeemConfirm", { points: tier.points_cost })))
      return;
    setBusy(true);
    setNotice("");
    try {
      const key = keys.current.get(tier.id) ?? crypto.randomUUID();
      keys.current.set(tier.id, key);
      const order = await client.createRedemption(tier.id, key);
      const result = await client.claimRedemption(order.id);
      keys.current.delete(tier.id);
      setReveal(result);
      await onChanged();
    } catch {
      setNotice(t("redeemRetrySafe"));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!reveal) return;
    await navigator.clipboard.writeText(reveal.code);
    setNotice(t("codeCopied"));
  };
  return (
    <section className="card redemption-centre">
      <h2>{t("redeemCentre")}</h2>
      {!tiers.length && <p className="muted">{t("redeemNoTiers")}</p>}
      {tiers.map((tier) => (
        <article className="redemption-tier" key={tier.id}>
          <div>
            <strong>
              {tier.display_name} · {tier.face_value} {tier.face_currency}
            </strong>
            <small>
              {formatPoints(tier.points_cost, locale)} {t("pointsUnit")}
            </small>
          </div>
          <button
            disabled={busy || tier.available < 1}
            onClick={() => void redeem(tier)}
          >
            {tier.available < 1 ? t("inventoryEmpty") : t("redeemNow")}
          </button>
        </article>
      ))}
      {reveal && (
        <div className="redemption-code" role="status">
          <small>{t("yourCode")}</small>
          <strong>{reveal.code}</strong>
          <button onClick={() => void copy()}>{t("copyCode")}</button>
          {reveal.redemptionUrl && (
            <a
              href={reveal.redemptionUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("openPlatform")}
            </a>
          )}
          <p className="muted">{t("platformUseNotice")}</p>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
