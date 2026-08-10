require('dotenv').config();
const { getNowPlaying } = require('./lib/navidrome');

(async () => {
  try {
    const track = await getNowPlaying();
    console.log('Track:', JSON.stringify(track, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
})();
