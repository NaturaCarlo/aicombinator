-- Agent skills table: stores skills associated with each agent
-- Synced from supervisor via sync_queue
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id    TEXT NOT NULL,
  skill_slug  TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, skill_slug)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
