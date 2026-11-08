-- POV replays as evidence for single detections (not only for bans).
ALTER TABLE replays DROP CONSTRAINT replays_kind_check;
ALTER TABLE replays ADD CONSTRAINT replays_kind_check CHECK (kind IN ('ban','manual','detection'));
ALTER TABLE replays ADD COLUMN detection_local_id text;
ALTER TABLE replays ADD COLUMN detection_id uuid REFERENCES detections(id) ON DELETE SET NULL;
CREATE INDEX replays_detection_idx ON replays (detection_id) WHERE detection_id IS NOT NULL;
CREATE INDEX replays_detection_local_idx ON replays (server_id, detection_local_id) WHERE detection_local_id IS NOT NULL;
