const { getNowPlaying } = require('./lib/musicassistant');
const { getSettings } = require('./lib/musicassistant');

async function test() {
  console.log('Testing MA connection...');
  try {
    const settings = await getSettings();
    console.log('Settings:', { ...settings, token_encrypted: settings?.token_encrypted ? '[HIDDEN]' : null });
    
    const track = await getNowPlaying();
    console.log('Result:', track);
  } catch(e) {
    console.error('Error:', e);
  }
}

test();
