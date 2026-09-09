-- Changes to a schema that is already live.
--
-- db/schema.sql builds an empty database; it is never re-run against one that has data,
-- so anything added after go-live has to arrive here instead. Applied on every boot by
-- both scripts/db-init.mjs and src/devdb.ts, which means every statement in this file
-- must be safe to run again on a database that already has it.
--
-- ponytail: idempotent DDL, not a migration tool — no ordering, no down, no record of
-- what ran. Fine while changes are additive. The first one that has to rewrite existing
-- rows is the one that needs a real migration runner.

-- ---------------------------------------------------- staff notifications

-- Notifications used to be a thing only clients received. Staff get them too now — a flag
-- raised, a document to check, a client waiting on a reply — so the subject of a row is
-- either a client or a staff member, and exactly one of the two.
ALTER TABLE notifications ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES staff(id);

DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT notifications_one_subject
    CHECK (num_nonnulls(client_id, staff_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS notifications_staff_recent ON notifications (staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_staff_unread ON notifications (staff_id) WHERE read_at IS NULL;

-- ------------------------------------------------- notification preferences

-- Which kinds of notification somebody wants. Absent means on: a kind added later reaches
-- everyone by default rather than silently going nowhere until each person opts in, and
-- the table stays small because it only records the exceptions.
--
-- subject_id is not a foreign key because it points at one of two tables depending on
-- subject_kind. The rows are preferences, not records — an orphan is noise, not a
-- correctness problem, and deleting a person is not something this system does anyway.
CREATE TABLE IF NOT EXISTS notification_prefs (
  subject_kind text NOT NULL CHECK (subject_kind IN ('client', 'staff')),
  subject_id   uuid NOT NULL,
  kind         text NOT NULL,
  enabled      boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id, kind)
);

-- ------------------------------------------------------- client personal details

-- The record a desk actually keeps on a person: enough to match them to their
-- identification, which is the point of holding it at all. Nullable throughout — a lead
-- who has given a name and an email is still a client record, and demanding a birth date
-- before anyone has asked for one is how you end up storing guesses.
--
-- These reach the audit log like every other client column. That is deliberate: a change
-- to someone's date of birth or address is exactly the change worth being able to see
-- afterwards. Only password_hash is stripped, by the audit trigger itself.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address text;

-- ------------------------------------------------------------- task states

-- Tasks were open, done or cancelled — a checklist. A board needs the middle: what is
-- being worked on now, and what is stuck waiting on somebody else. Both existing values
-- keep their meaning, so nothing has to be rewritten; the check just admits two more.
DO $$ BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled'));
END $$;
