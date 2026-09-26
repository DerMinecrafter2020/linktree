-- Zuletzt akzeptierter TOTP-Zeitschritt (verhindert Wiederverwendung eines Codes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_timestep BIGINT;
