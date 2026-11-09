#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.gz': 'application/gzip',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.map': 'application/json',
};

export async function startServer({ root = path.join(PROJECT_ROOT, 'dist/pages'), host = '127.0.0.1', port = 4173, base = '/' } = {}) {
  root = await realpath(path.resolve(root));
  if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..') || base.includes('\\')) {
    throw new Error('Preview base must be an absolute URL path ending in /.');
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); response.end('Bad URL'); return; }
    if (pathname.includes('\0') || pathname.includes('\\')) { response.writeHead(400); response.end(); return; }
    if (base !== '/' && (pathname === base.slice(0, -1) || pathname === '/')) {
      response.writeHead(302, { Location: base }); response.end(); return;
    }
    if (!pathname.startsWith(base)) { response.writeHead(404); response.end(); return; }
    const relative = pathname.slice(base.length);
    let file = path.resolve(root, relative);
    const inside = target => target === root || (path.relative(root, target) !== '..' && !path.relative(root, target).startsWith('..' + path.sep) && !path.isAbsolute(path.relative(root, target)));
    if (!inside(file)) { response.writeHead(403); response.end(); return; }
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) { response.writeHead(301, { Location: pathname + '/' }); response.end(); return; }
        file = path.join(file, 'index.html'); info = await stat(file);
      }
      const actual = await realpath(file);
      if (!inside(actual) || !info.isFile()) { response.writeHead(403); response.end(); return; }
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { response.writeHead(404); response.end('Not found'); }
      else { response.writeHead(500); response.end('Preview error'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { server, root, url: `http://${host}:${address.port}${base}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!value || !['--port', '--root', '--base'].includes(flag)) {
      console.error('Usage: node tools/serve.mjs [--port 4173] [--root dist/pages] [--base /baidu-panorama-workbench/]');
      process.exitCode = 1; break;
    }
    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('Invalid port'); process.exitCode = 1; break; }
      options.port = port;
    } else if (flag === '--root') options.root = path.resolve(PROJECT_ROOT, value);
    else options.base = value;
  }
  if (!process.exitCode) {
    startServer(options).then(preview => {
      console.log('Baidu workbench preview: ' + preview.url);
      const stop = () => { preview.close().then(() => { process.exitCode = 0; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
