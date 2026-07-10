import { query } from './src/lib/db';

async function main() {
  const { rows } = await query('twitter_accounts', {});
  console.log(`Total accounts: ${rows.length}`);
  for (const a of rows) {
    console.log(`  - ${a.nickname} (@${a.twitter_handle}) | status: ${a.status} | can_comment: ${a.can_comment}`);
  }
  process.exit(0);
}
main();