-- User profiles: enriched data from X/Twitter OAuth signup
-- Populated asynchronously after user.created webhook

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,       -- Clerk user ID (FK to users.id)
  x_handle TEXT,                  -- Twitter/X username
  x_display_name TEXT,            -- Display name from X profile
  x_bio TEXT,                     -- Bio from X profile
  x_avatar_url TEXT,              -- Profile picture URL from X
  x_followers_count INTEGER,
  x_location TEXT,                -- Self-reported location from X
  country TEXT,                   -- Detected country code (ISO 3166-1 alpha-2, e.g. "IT", "US", "JP")
  country_name TEXT,              -- Full country name (e.g. "Italy", "United States", "Japan")
  language TEXT,                  -- Primary language detected
  profile_summary TEXT,           -- AI-generated summary of who this person is
  interests TEXT,                 -- JSON array of detected interests
  enrichment_status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | complete | failed
  enrichment_error TEXT,          -- Error message if enrichment failed
  enriched_at TEXT,               -- Timestamp when enrichment completed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_status ON user_profiles(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_user_profiles_country ON user_profiles(country);
