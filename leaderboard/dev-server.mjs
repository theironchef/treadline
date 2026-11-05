// A stand-in for the deployed Apps Script web app, for trying the Club tab
// locally: `node leaderboard/dev-server.mjs`, then use
// http://localhost:5175/exec as the club link. Like the real one, it answers
// every request with a redirect to the reply, and allows any origin.
import http from 'node:http';
import { loadScript } from './fake-sheets.mjs';

const PORT = Number(process.env.PORT) || 5175;
const script = loadScript();
const replies = new Map();
let next = 0;
const CORS = { 'Access-Control-Allow-Origin': '*' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const answer = (data) => {
      const id = String(next++);
      replies.set(id, JSON.stringify(data));
      res.writeHead(302, { ...CORS, Location: `/echo?id=${id}` });
      res.end();
    };
    if (url.pathname === '/exec' && req.method === 'GET') {
      answer(script.get(Object.fromEntries(url.searchParams)));
    } else if (url.pathname === '/exec' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => answer(script.post(body)));
    } else if (url.pathname === '/echo' && replies.has(url.searchParams.get('id'))) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(replies.get(url.searchParams.get('id')));
      replies.delete(url.searchParams.get('id'));
    } else {
      res.writeHead(404, CORS);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`Club stand-in: http://localhost:${PORT}/exec`));
