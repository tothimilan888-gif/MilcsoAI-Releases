DELETE FROM replays WHERE kind = 'detection';
ALTER TABLE replays DROP COLUMN IF EXISTS detection_id;
ALTER TABLE replays DROP COLUMN IF EXISTS detection_local_id;
ALTER TABLE replays DROP CONSTRAINT replays_kind_check;
ALTER TABLE replays ADD CONSTRAINT replays_kind_check CHECK (kind IN ('ban','manual'));
