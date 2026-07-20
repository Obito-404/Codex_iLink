ALTER TABLE bridge_settings
ADD COLUMN default_permission_profile TEXT NOT NULL DEFAULT ':workspace'
CHECK (default_permission_profile IN (':read-only', ':workspace', ':danger-full-access'));

ALTER TABLE bridge_settings
ADD COLUMN default_approval_policy TEXT NOT NULL DEFAULT 'on-request'
CHECK (default_approval_policy IN ('never', 'on-request'));

ALTER TABLE bridge_settings
ADD COLUMN default_approvals_reviewer TEXT NOT NULL DEFAULT 'auto_review'
CHECK (default_approvals_reviewer IN ('auto_review', 'user'));
