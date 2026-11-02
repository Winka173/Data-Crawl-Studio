// Serves the synthetic YouTube fixture over HTTP for smoke tests of the built app.
//   npx tsx scripts/fake-youtube-server.ts            -> prints {"port":N,"key":"..."} on stdout
// Test hooks (smoke only): POST /__fake/add-video, POST /__fake/calls
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeYoutube } from '../worker/test/fixtures/youtube/fakeApi';

const yt = new FakeYoutube(Date.now());

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/__fake/add-video') {
    const v = yt.addVideo(0);
    res.end(JSON.stringify({ id: v.id }));
    return;
  }
  if (url.pathname === '/__fake/calls') {
    res.end(JSON.stringify({ calls: yt.calls.length }));
    return;
  }
  const r = await yt.fetch(`http://127.0.0.1${url.pathname}${url.search}`);
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(await r.text());
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: (server.address() as AddressInfo).port, key: yt.validKey }) + '\n');
});
