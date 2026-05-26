-- Migration 009: provenance for company telemetry

ALTER TABLE telemetry_records
  ADD COLUMN source TEXT NOT NULL DEFAULT 'crm_import';

ALTER TABLE telemetry_records
  ADD COLUMN source_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_company_source_event
  ON telemetry_records(company_id, source, source_event_id);
