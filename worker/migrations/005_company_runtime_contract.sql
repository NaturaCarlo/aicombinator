-- Migration 005: product contract fields for domains, email identity, and runtime tiering

ALTER TABLE companies ADD COLUMN hosted_domain TEXT;
ALTER TABLE companies ADD COLUMN email_domain TEXT;
ALTER TABLE companies ADD COLUMN custom_domain_candidate TEXT;
ALTER TABLE companies ADD COLUMN custom_domain_status TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE companies ADD COLUMN runtime_tier TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE companies ADD COLUMN dedicated_vm_status TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE companies ADD COLUMN dedicated_vm_id TEXT;
ALTER TABLE companies ADD COLUMN dedicated_vm_ip TEXT;
ALTER TABLE companies ADD COLUMN egress_tier TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE agents ADD COLUMN email_address TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_hosted_domain
  ON companies (hosted_domain);
CREATE INDEX IF NOT EXISTS idx_companies_runtime_tier
  ON companies (runtime_tier, dedicated_vm_status);
CREATE INDEX IF NOT EXISTS idx_companies_custom_domain_status
  ON companies (custom_domain_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_company_email
  ON agents (company_id, email_address);
