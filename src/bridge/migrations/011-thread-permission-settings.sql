ALTER TABLE thread_permission_profiles
  ADD COLUMN approval_policy TEXT
  CHECK (approval_policy IN ('never', 'on-request', 'untrusted'));

ALTER TABLE thread_permission_profiles
  ADD COLUMN approvals_reviewer TEXT
  CHECK (approvals_reviewer IN ('auto_review', 'guardian_subagent', 'user'));
