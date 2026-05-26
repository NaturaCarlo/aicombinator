-- Migration 021: Agent custom instructions
-- Adds instructions column for user-editable system prompt content

ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
