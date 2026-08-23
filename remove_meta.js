const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'public');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const metaTags = [
  /<meta http-equiv="Content-Security-Policy"[^>]*>/g,
  /<meta http-equiv="X-Content-Type-Options"[^>]*>/g,
  /<meta http-equiv="Referrer-Policy"[^>]*>/g,
  /<meta http-equiv="Permissions-Policy"[^>]*>/g
];

files.forEach(file => {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  metaTags.forEach(regex => {
    content = content.replace(regex, '');
  });

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`Updated ${file}`);
  }
});
