-- Migration 023: Agent system_prompt
-- Adds system_prompt column for complete system prompt override.
-- When non-null, this is used as the COMPLETE prompt at runtime
-- (NOT appended to the blueprint). When null, the agent falls back
-- to the blueprint-derived system prompt.

ALTER TABLE agents ADD COLUMN system_prompt TEXT;
