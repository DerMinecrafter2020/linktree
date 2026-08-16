const fs = require('fs');
const path = require('path');
const https = require('https');

const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap';
const FONTS_DIR = path.join(__dirname, 'public', 'fonts');

if (!fs.existsSync(FONTS_DIR)) {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

function fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching CSS...');
  const cssBuffer = await fetch(FONT_CSS_URL, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  });
  let css = cssBuffer.toString();
  
  const urlRegex = /url\((https:\/\/[^)]+)\)/g;
  let match;
  let fontCount = 0;
  
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[1];
    const filename = `font-${fontCount++}.woff2`;
    const filepath = path.join(FONTS_DIR, filename);
    
    console.log(`Downloading ${url} to ${filename}...`);
    const fontBuffer = await fetch(url);
    fs.writeFileSync(filepath, fontBuffer);
    
    css = css.replace(url, `/fonts/${filename}`);
  }
  
  fs.writeFileSync(path.join(__dirname, 'public', 'fonts.css'), css);
  console.log('Done! Generated public/fonts.css');
}

main().catch(console.error);
