-- Links nur fuer angemeldete Admins: Besucher ("Gaeste") sehen sie weder auf der Startseite noch
-- ueber /go/<kurzlink>, Sitemap oder die oeffentliche API (lib/visibility.js).
ALTER TABLE links ADD COLUMN IF NOT EXISTS admin_only BOOLEAN NOT NULL DEFAULT false;
