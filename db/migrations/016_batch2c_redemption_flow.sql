-- Batch 2C: member-facing fixed-tier redemption flow.
-- Installation is inert: no orders, codes, Points or historical rows are created.

ALTER TABLE platforms
  ADD COLUMN redemption_url text,
  ADD CONSTRAINT platform_redemption_url_https CHECK (
    redemption_url IS NULL OR redemption_url ~ '^https://[^[:space:]]+$'
  );

ALTER TABLE redemptions DROP CONSTRAINT redemptions_status_check;
ALTER TABLE redemptions
  ADD COLUMN platform_id uuid,
  ADD COLUMN member_id uuid,
  ADD COLUMN business_date date,
  ADD COLUMN code_assigned_at timestamptz,
  ADD COLUMN code_claimed_at timestamptz,
  ADD COLUMN refunded_at timestamptz,
  ADD COLUMN review_reason text,
  ADD COLUMN reviewed_by uuid REFERENCES admins(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT redemptions_status_check CHECK(status IN (
    'pending','processing','success','failed','cancelled',
    'code_assigned','code_claimed','review_required','refunded'
  )),
  ADD FOREIGN KEY(brand_id,platform_id) REFERENCES platforms(brand_id,id),
  ADD FOREIGN KEY(brand_id,member_id) REFERENCES members(brand_id,id);

ALTER TABLE redemptions ADD CONSTRAINT redemption_v2_order_shape CHECK (
  platform_id IS NULL OR (
    member_id IS NOT NULL AND business_date IS NOT NULL
    AND points_cost BETWEEN 1 AND 300
    AND code_assigned_at IS NOT NULL
    AND (
      (status='code_assigned' AND code_claimed_at IS NULL AND refunded_at IS NULL)
      OR (status='code_claimed' AND code_claimed_at IS NOT NULL AND refunded_at IS NULL)
      OR (status='review_required' AND review_reason IS NOT NULL AND refunded_at IS NULL)
      OR (status='refunded' AND review_reason IS NOT NULL AND refunded_at IS NOT NULL)
    )
    AND ((reviewed_by IS NULL)=(reviewed_at IS NULL))
  )
);

CREATE UNIQUE INDEX redemption_member_platform_day_active
  ON redemptions(brand_id,platform_id,member_id,business_date)
  WHERE platform_id IS NOT NULL AND status<>'refunded';
CREATE INDEX redemption_admin_v2_queue
  ON redemptions(brand_id,bot_id,status,created_at DESC,id DESC)
  WHERE platform_id IS NOT NULL;

ALTER TABLE redemption_codes
  ADD COLUMN claimed_at timestamptz;
UPDATE redemption_codes
  SET claimed_at=COALESCE(assigned_at,created_at)
  WHERE status='used';
ALTER TABLE redemption_codes
  ADD CONSTRAINT redemption_code_claimed_shape CHECK (
    (status='used' AND claimed_at IS NOT NULL)
    OR (status<>'used' AND claimed_at IS NULL)
  );

-- The existing review permission is reused. No new role or permission is needed.
