-- Drop obsolete tables (Phase 5: Unify Data Model)
-- issues: replaced by tasks (synced from supervisor)
-- issue_comments: associated with issues
-- goals: scaffolding, never used by supervisor or agents
-- projects: scaffolding, never used by supervisor or agents
-- policies: default rows only, no enforcement code
-- policy_counters: associated with policies
-- agent_task_sessions: never written to

DROP TABLE IF EXISTS issue_comments;
DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS policy_counters;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS agent_task_sessions;
