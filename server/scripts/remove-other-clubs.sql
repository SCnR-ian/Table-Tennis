-- remove-other-clubs.sql
-- Deletes every club except Epping and all of their data, plus Flinther
-- platform-owner accounts (users with no club and platform_owner = TRUE).
-- Rows whose club_id is empty are never deleted, only reported.
--
-- SAFE BY DEFAULT: everything runs in one transaction that ends in ROLLBACK,
-- so a first run only shows what WOULD be deleted. When the counts look right,
-- change the last line to COMMIT and run it again.
--
-- 1. Back up first:   pg_dump "$DATABASE_URL" > backup-before-cleanup.sql
-- 2. Dry run:         psql "$DATABASE_URL" -f server/scripts/remove-other-clubs.sql
-- 3. For real:        change ROLLBACK to COMMIT at the bottom, run again.

\set ON_ERROR_STOP on
BEGIN;

-- The club to keep.
CREATE TEMP TABLE keep_club AS
  SELECT id FROM clubs WHERE subdomain = 'epping';
DO $$ BEGIN
  IF (SELECT count(*) FROM keep_club) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one club with subdomain epping';
  END IF;
END $$;

\echo '== Clubs that will be removed:'
SELECT id, name, subdomain FROM clubs WHERE id <> (SELECT id FROM keep_club);

\echo '== Flinther platform-owner accounts that will be removed:'
SELECT id, name, email FROM users WHERE club_id IS NULL AND platform_owner IS TRUE;

\echo '== Rows that will be removed, per table:'
DO $$
DECLARE t text; n bigint; keep int := (SELECT id FROM keep_club);
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'club_id' AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'clubs'
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE club_id <> %s', t, keep) INTO n;
    IF n > 0 THEN RAISE NOTICE '%: % row(s)', t, n; END IF;
  END LOOP;
END $$;

-- Delete in repeated passes. Tables reference each other without cascades, so
-- a delete that is blocked by a foreign key is retried on the next pass, after
-- the rows that point at it are gone.
DO $$
DECLARE
  t text; n bigint; total bigint; pass int := 0;
  keep int := (SELECT id FROM keep_club);
BEGIN
  LOOP
    pass := pass + 1; total := 0;
    FOR t IN
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables tb USING (table_schema, table_name)
      WHERE c.column_name = 'club_id' AND c.table_schema = 'public'
        AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'clubs'
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE club_id <> %s', t, keep);
        GET DIAGNOSTICS n = ROW_COUNT;
        total := total + n;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;  -- still referenced; try again next pass
      END;
    END LOOP;
    BEGIN
      DELETE FROM users WHERE club_id IS NULL AND platform_owner IS TRUE;
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
      DELETE FROM clubs WHERE id <> keep;
      GET DIAGNOSTICS n = ROW_COUNT;
      total := total + n;
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    EXIT WHEN total = 0 OR pass >= 20;
  END LOOP;
  RAISE NOTICE 'Finished after % pass(es).', pass;
END $$;

\echo '== Left over after cleanup (should be one Epping club and no other rows):'
SELECT id, name, subdomain FROM clubs;
DO $$
DECLARE t text; n bigint; bad int := 0; keep int := (SELECT id FROM keep_club);
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'club_id' AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'clubs'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE club_id <> %s', t, keep) INTO n;
    IF n > 0 THEN bad := bad + 1; RAISE WARNING '% still has % non-Epping row(s)', t, n; END IF;
  END LOOP;
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'club_id' AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'clubs'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE club_id IS NULL', t) INTO n;
    IF n > 0 THEN RAISE WARNING '% has % row(s) with no club_id (left untouched)', t, n; END IF;
  END LOOP;
  IF (SELECT count(*) FROM users WHERE club_id IS NULL AND platform_owner IS TRUE) > 0 THEN
    bad := bad + 1; RAISE WARNING 'Some platform-owner accounts could not be deleted';
  END IF;
  IF bad = 0 THEN RAISE NOTICE 'OK: only Epping data remains.'; END IF;
END $$;

ROLLBACK;   -- change to COMMIT once the dry run looks right
