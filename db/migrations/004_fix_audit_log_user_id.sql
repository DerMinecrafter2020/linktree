-- Fix user_id datatype mismatch between users.id (INTEGER) and audit_log.user_id (UUID)
ALTER TABLE audit_log ALTER COLUMN user_id TYPE INTEGER USING NULL;
