WITH legacy_assistant_messages AS (
  SELECT
    assistant.id AS assistant_message_id,
    assistant.session_id,
    assistant.content,
    assistant.created_at,
    (
      SELECT founder.id
      FROM launch_session_messages founder
      WHERE founder.session_id = assistant.session_id
        AND founder.role = 'founder'
        AND (
          founder.created_at < assistant.created_at
          OR (founder.created_at = assistant.created_at AND founder.id < assistant.id)
        )
      ORDER BY founder.created_at DESC, founder.id DESC
      LIMIT 1
    ) AS founder_message_id
  FROM launch_session_messages assistant
  LEFT JOIN launch_session_turns existing
    ON existing.assistant_message_id = assistant.id
  WHERE assistant.role = 'assistant'
    AND existing.assistant_message_id IS NULL
),
ranked_legacy_turns AS (
  SELECT
    assistant_message_id,
    session_id,
    content,
    created_at,
    founder_message_id,
    ROW_NUMBER() OVER (
      PARTITION BY founder_message_id
      ORDER BY created_at DESC, assistant_message_id DESC
    ) AS founder_rank
  FROM legacy_assistant_messages
)
INSERT INTO launch_session_turns (
  id,
  session_id,
  founder_message_id,
  assistant_message_id,
  status,
  attempts,
  provider,
  model,
  duration_ms,
  last_error,
  started_at,
  completed_at,
  prompt_chars,
  transcript_messages,
  status_code,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  session_id,
  founder_message_id,
  assistant_message_id,
  CASE
    WHEN content LIKE '[[processing-opus]] %' THEN 'processing'
    WHEN content LIKE '[[pending-opus]] %' THEN 'pending'
    WHEN content LIKE '[[error-opus]] %' THEN 'error'
    ELSE 'complete'
  END AS status,
  CASE
    WHEN content LIKE '[[pending-opus]] %' THEN 0
    ELSE 1
  END AS attempts,
  NULL AS provider,
  NULL AS model,
  NULL AS duration_ms,
  CASE
    WHEN content LIKE '[[error-opus]] %' THEN substr(content, length('[[error-opus]] ') + 1)
    ELSE NULL
  END AS last_error,
  NULL AS started_at,
  CASE
    WHEN content LIKE '[[pending-opus]] %' THEN NULL
    ELSE created_at
  END AS completed_at,
  NULL AS prompt_chars,
  NULL AS transcript_messages,
  NULL AS status_code,
  created_at,
  created_at
FROM ranked_legacy_turns
WHERE founder_message_id IS NOT NULL
  AND founder_rank = 1;
