-- Discord-Template ist normaler Text (z. B. "Neuer Klick auf **{{title}}**"), kein JSON.
-- Als JSONB schlug jedes Speichern eines eigenen Templates fehl.
-- #>> '{}' uebernimmt vorhandene JSON-Strings ohne Anfuehrungszeichen.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_settings'
      AND column_name = 'discord_webhook_template'
      AND data_type = 'jsonb'
  ) THEN
    ALTER TABLE admin_settings
      ALTER COLUMN discord_webhook_template TYPE TEXT
      USING discord_webhook_template #>> '{}';
  END IF;
END $$;
