/**
 * npm start [-- --port=<n>]: read-only local preview of the static site in docs/ (plan.md section 9).
 * Binds 127.0.0.1, accepts only a 127.0.0.1 or localhost Host header, serves files under docs/
 * and nothing else, sends the site's CSP as a header. Reads no environment variable and no .env.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const ROOT = fileURLToPath(new URL('./docs/', import.meta.url));

/** The file under `root` for a URL path, or null when the path would leave `root`. */
function fileFor(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const file = resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
  return file.startsWith(resolve(root) + sep) ? file : null;
}

async function readServable(file) {
  if (!file || !(await stat(file).catch(() => null))?.isFile()) return null;
  return readFile(file);
}

/** Create (not start) the preview server for `root`. */
export function previewServer({ root = ROOT } = {}) {
  return createServer(async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const port = req.socket.localPort;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(403, 'Forbidden host\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed\n');
    let file;
    try {
      file = fileFor(root, new URL(req.url, 'http://x').pathname);
    } catch {
      return send(400, 'Bad request\n');
    }
    const body = await readServable(file);
    if (!body) return send(404, 'Not found\n');
    send(200, req.method === 'HEAD' ? undefined : body, TYPES[extname(file)] ?? 'application/octet-stream');
  });
}

function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8080' } } });
  const port = Number(values.port);
  const server = previewServer().listen(port, '127.0.0.1', () => {
    console.log(`Preview of docs/ at http://127.0.0.1:${server.address().port}/ (read-only, Ctrl+C to stop)`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
