-- ─── Add title and description to cron_tasks for automations ────
-- These columns support the founder-facing automations feature.
ALTER TABLE cron_tasks ADD COLUMN title TEXT;
ALTER TABLE cron_tasks ADD COLUMN description TEXT;
