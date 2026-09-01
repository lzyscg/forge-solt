-- Execution replay provenance.
--
-- These columns deliberately stay nullable for executions created before this migration.
-- The full envelope is read separately from the public Execution projection because it can
-- be large; the hash covers the exact canonical JSON bytes stored in replay_input_json.
ALTER TABLE executions ADD COLUMN replay_input_json TEXT NULL;
ALTER TABLE executions ADD COLUMN replay_input_hash TEXT NULL;
