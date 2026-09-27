#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

interface CliArgs {
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  captureRoot?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { transport: 'stdio', port: 8931, host: '127.0.0.1', captureRoot: undefined, help: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--transport':
      case '-t':
        args.transport = argv[++i] === 'http' ? 'http' : 'stdio';
        break;
      case '--port':
      case '-p':
        args.port = Number(argv[++i]);
        break;
      case '--host':
        args.host = String(argv[++i]);
        break;
      case '--capture-root':
        args.captureRoot = String(argv[++i]);
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(args.port) || args.port <= 0 || args.port > 65535) args.port = 8931;
  return args;
}

function usage(version: string): string {
  return [
    `cdp-browser-mcp v${version}`,
    '',
    '用法：cdp-browser-mcp [选项]',
    '',
    '选项：',
    '  -t, --transport <stdio|http>  传输方式，默认 stdio',
    '  -p, --port <number>           HTTP 传输监听端口，默认 8931',
    '      --host <address>          HTTP 监听地址，默认 127.0.0.1',
    '      --capture-root <dir>      抓取产物根目录，默认 <cwd>/captures',
    '  -h, --help                    显示本帮助',
    '',
    'stdio 是 MCP 客户端默认使用的方式，不要向 stdout 打印任何日志。',
  ].join('\n');
}

async function runStdio(version: string, captureRoot?: string): Promise<void> {
  const { server } = createServer({ version, captureRoot });
  await server.connect(new StdioServerTransport());
}

async function runHttp(version: string, args: CliArgs): Promise<void> {
  // One hub shared by every HTTP session so a browser stays attached across requests.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    void (async () => {
      try {
        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'session not found' }));
            return;
          }
          await existing.handleRequest(req, res);
          return;
        }

        if (req.method === 'POST') {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          const { server } = createServer({ version: version, captureRoot: args.captureRoot });
          await server.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'POST required to start a session' }));
      } catch (err) {
        console.error('[cdp-browser-mcp] 处理 HTTP 请求失败:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      }
    })();
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(args.port, args.host, () => resolvePromise());
  });

  console.error(`[cdp-browser-mcp] HTTP 传输已启动：http://${args.host}:${args.port}/mcp`);

  const shutdown = (): void => {
    for (const transport of sessions.values()) transport.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const version = readVersion();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${usage(version)}\n`);
    return;
  }

  if (args.transport === 'http') {
    await runHttp(version, args);
    return;
  }
  await runStdio(version, args.captureRoot);
}

main().catch((err) => {
  console.error('[cdp-browser-mcp] 启动失败:', err);
  process.exit(1);
});
