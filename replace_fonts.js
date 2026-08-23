const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'public');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const regexPreconnect1 = /<link\s+rel="preconnect"\s+href="https:\/\/fonts\.googleapis\.com"\s*\/?\s*>/g;
const regexPreconnect2 = /<link\s+rel="preconnect"\s+href="https:\/\/fonts\.gstatic\.com"\s+crossorigin\s*\/?\s*>/g;
const regexStylesheet = /<link\s+href="https:\/\/fonts\.googleapis\.com\/css2\?family=Space\+Grotesk:wght@400;500;600;700&family=JetBrains\+Mono:wght@400;600&display=swap"\s+rel="stylesheet"\s*\/?\s*>/g;
const regexCSP1 = /https:\/\/fonts\.googleapis\.com/g;
const regexCSP2 = /https:\/\/fonts\.gstatic\.com/g;

files.forEach(file => {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  content = content.replace(regexPreconnect1, '');
  content = content.replace(regexPreconnect2, '');
  
  if (content.match(regexStylesheet)) {
      content = content.replace(regexStylesheet, '<link rel="stylesheet" href="/fonts.css" />');
  }

  content = content.replace(regexCSP1, '');
  content = content.replace(regexCSP2, '');

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`Updated ${file}`);
  }
});
