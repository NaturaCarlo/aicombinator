-- Migration 017: External agent support
-- Adds columns for external agent registration (webhook URL, adapter type, source)

ALTER TABLE agents ADD COLUMN webhook_url TEXT;
ALTER TABLE agents ADD COLUMN adapter_type TEXT;
ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'internal';
