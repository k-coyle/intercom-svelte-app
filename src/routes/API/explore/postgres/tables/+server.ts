// src/routes/API/explore/postgres/tables/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exploreQuery } from '$lib/server/postgresClient';

function exploreEnabled(): boolean {
  // Keep this internal/dev-only. Flip on explicitly in your .env when needed.
  return (env.EXPLORER_ENABLED || '').toLowerCase() === 'true';
}

export async function GET({ url }) {
  if (!exploreEnabled()) throw error(404, 'Not found');

  // Optional filter: /API/explore/postgres/tables?schema=public
  const schema = url.searchParams.get('schema'); // null means "all non-system schemas"

  const result = await exploreQuery<{ table_schema: string; table_name: string }>('tables', [
    schema
  ]);

  return json(
    {
      count: result.rowCount ?? result.rows.length,
      rows: result.rows
    },
    {
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
}
