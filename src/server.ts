import { openDatabase } from './db.ts';
import { handleRequest } from './router.ts';

const PORT = Number(process.env.PORT ?? 3000);

const db = openDatabase();

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    return handleRequest(db, request);
  },
  error(err) {
    return new Response(JSON.stringify({ error: 'internal server error', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`podr-service listening on http://${server.hostname}:${server.port}`);
