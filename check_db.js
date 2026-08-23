const { Client } = require('pg');
const client = new Client({
  connectionString: 'postgresql://openweb:openweb@localhost:5432/openweb'
});

async function run() {
  try {
    await client.connect();
    const res = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log('Tables:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}
run();
