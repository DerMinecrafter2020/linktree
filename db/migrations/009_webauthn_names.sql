ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS name VARCHAR(255) DEFAULT 'Security Key';
