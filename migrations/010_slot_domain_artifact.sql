ALTER TABLE slots ADD COLUMN domain_artifact_kind TEXT;
ALTER TABLE slots ADD COLUMN domain_artifact_version INTEGER;
ALTER TABLE slots ADD COLUMN domain_artifact_json TEXT;
ALTER TABLE slots ADD COLUMN domain_artifact_hash TEXT;

CREATE TRIGGER slots_domain_artifact_insert_complete
BEFORE INSERT ON slots
WHEN (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_version IS NULL)
  OR (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_json IS NULL)
  OR (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'slot domain artifact columns must be all null or all non-null');
END;

CREATE TRIGGER slots_domain_artifact_update_complete
BEFORE UPDATE OF domain_artifact_kind, domain_artifact_version, domain_artifact_json, domain_artifact_hash ON slots
WHEN (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_version IS NULL)
  OR (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_json IS NULL)
  OR (NEW.domain_artifact_kind IS NULL) != (NEW.domain_artifact_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'slot domain artifact columns must be all null or all non-null');
END;
