require('dotenv').config();
const db = require('./lib/db');
const { getSettings, subsonicRequest, getRadioStations } = require('./lib/navidrome');
const { decrypt } = require('./lib/crypto');

async function test() {
  const settings = await getSettings();
  if (!settings) {
    console.log("No settings found");
    process.exit(1);
  }
  const password = decrypt(settings.password_encrypted);
  
  console.log("Fetching now playing...");
  let response;
  try {
    response = await subsonicRequest(settings.url, settings.username, password, '/rest/getNowPlaying');
  } catch(e) {
    console.error("Error fetching now playing:", e);
  }
  
  console.log("Now playing raw response:", JSON.stringify(response, null, 2));

  console.log("Fetching radio stations...");
  const stations = await getRadioStations(settings.url, settings.username, password);
  console.log("Radio stations:", JSON.stringify(stations, null, 2));

  process.exit(0);
}

test();
