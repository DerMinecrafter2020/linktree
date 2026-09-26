-- Einheitlicher Icon-Stil fuer alle Links: 'white' (weisse Silhouetten) oder 'color' (Originalfarben)
ALTER TABLE profile
  ADD COLUMN IF NOT EXISTS icon_style VARCHAR(10) NOT NULL DEFAULT 'white'
  CHECK (icon_style IN ('white', 'color'));
