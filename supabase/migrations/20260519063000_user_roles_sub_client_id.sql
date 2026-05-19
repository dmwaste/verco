-- VER-216 — Sub-client scoping on user_roles
--
-- Adds an optional `sub_client_id` column to `user_roles` for client-tier roles
-- (client-admin, client-staff, ranger). NULL = full client scope (all
-- sub-clients) so existing rows are unaffected. Cross-table integrity is
-- enforced by a composite FK to sub_client(id, client_id), which is far
-- cleaner than a trigger-based check.
--
-- Backward compatibility: every existing user_roles row keeps
-- sub_client_id = NULL, which the RLS helpers (see follow-up migration)
-- interpret as "full scope". Behaviour for the 12 existing signed-in users
-- is unchanged.
--
-- Linear: VER-216

-- 1. Composite uniqueness on sub_client lets us build the multi-column FK
--    below. (id) is already PK so id alone is unique, but Postgres requires
--    the *exact* column set to be a UNIQUE/PK constraint for a composite FK
--    to reference it.
ALTER TABLE sub_client
  ADD CONSTRAINT sub_client_id_client_id_key UNIQUE (id, client_id);

-- 2. New nullable column.
ALTER TABLE user_roles
  ADD COLUMN sub_client_id uuid;

-- 3. Composite FK enforces the (sub_client_id, client_id) pair belongs to a
--    sub_client row. MATCH SIMPLE (the default) skips the check when
--    sub_client_id IS NULL, which is exactly the behaviour we want.
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_sub_client_fk
    FOREIGN KEY (sub_client_id, client_id)
    REFERENCES sub_client(id, client_id)
    ON DELETE RESTRICT;

-- 4. The composite FK also skips when client_id IS NULL — that would let
--    someone write (sub_client_id, NULL) which is meaningless. Explicit
--    CHECK blocks that orphan state.
ALTER TABLE user_roles
  ADD CONSTRAINT chk_sub_client_requires_client
  CHECK (sub_client_id IS NULL OR client_id IS NOT NULL);

-- 5. Partial index for RLS filtering. Most rows will have NULL so a partial
--    index is cheaper than a full index.
CREATE INDEX idx_user_roles_sub_client_id
  ON user_roles(sub_client_id)
  WHERE sub_client_id IS NOT NULL;

COMMENT ON COLUMN user_roles.sub_client_id IS
  'When set, scopes this user to a single sub-client within their client. '
  'NULL means full client scope (all sub-clients). '
  'Only meaningful for client-tier roles (client-admin, client-staff, ranger). '
  'See VER-216.';
