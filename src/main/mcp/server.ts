// Nest's MCP server. Codex and Claude Code launch this script as a stdio MCP
// server; it forwards tool calls to the running Nest app over a local pipe.
// It is deliberately self-contained (no app imports) and holds no logic of its
// own: tool definitions and behaviour live in the Nest main process.
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const bridgePath = process.env.NEST_BRIDGE ?? '';
const token = process.env.NEST_TOKEN ?? '';
// Opt-in troubleshooting log of protocol traffic (no tool results are secret, but keep it off by default).
const logFile = process.env.NEST_MCP_LOG;
const log = (line: string) => {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${line}${String.fromCharCode(10)}`);
};
log(`start pid=${process.pid} bridge=${bridgePath ? 'set' : 'missing'}`);
process.on('exit', (code) => log(`exit ${code}`));
process.on('uncaughtException', (err) => {
  log(`crash ${err.stack ?? err.message}`);
  process.exit(1);
});

let bridge: net.Socket | null = null;
let bridgeBuf = '';
let nextId = 1;
type BridgeReply = { ok: boolean; text: string; tools?: unknown[]; image?: { data: string; mimeType: string } };
const pending = new Map<number, (res: BridgeReply) => void>();

function connect(): Promise<net.Socket> {
  if (bridge && !bridge.destroyed) return Promise.resolve(bridge);
  return new Promise((resolve, reject) => {
    const sock = net.connect(bridgePath);
    sock.setEncoding('utf8');
    sock.once('connect', () => {
      bridge = sock;
      resolve(sock);
    });
    sock.once('error', reject);
    sock.on('data', (chunk: string) => {
      bridgeBuf += chunk;
      let i: number;
      while ((i = bridgeBuf.indexOf('\n')) >= 0) {
        const line = bridgeBuf.slice(0, i);
        bridgeBuf = bridgeBuf.slice(i + 1);
        try {
          const msg = JSON.parse(line) as BridgeReply & { id: number };
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        } catch {
          /* ignore malformed bridge line */
        }
      }
    });
    sock.on('close', () => {
      bridge = null;
      for (const [, cb] of pending) cb({ ok: false, text: 'Nest is not running or closed the connection.' });
      pending.clear();
    });
  });
}

async function callBridge(tool: string, args: unknown): Promise<BridgeReply> {
  try {
    const sock = await connect();
    const id = nextId++;
    return await new Promise((resolve) => {
      pending.set(id, resolve);
      sock.write(`${JSON.stringify({ id, token, tool, args })}\n`);
    });
  } catch (err) {
    return { ok: false, text: `Could not reach Nest: ${(err as Error).message}` };
  }
}

function send(msg: unknown): void {
  log(`-> ${JSON.stringify(msg).slice(0, 300)}`);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }): Promise<void> {
  if (msg.method === undefined || msg.id === undefined) return; // notifications need no reply
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'nest', version: '1.0.0' },
          instructions: 'Tools for working inside Nest: your profile and instructions, memory notes, other agents, delegation and schedules.',
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    case 'tools/list': {
      const res = await callBridge('__list', {});
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: res.tools ?? [] } });
      return;
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const res = await callBridge(name, msg.params?.arguments ?? {});
      const content: unknown[] = [{ type: 'text', text: res.text }];
      if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
      send({ jsonrpc: '2.0', id: msg.id, result: { content, isError: !res.ok } });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    log(`<- ${line.slice(0, 300)}`);
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed input line */
    }
  }
});
process.stdin.on('end', () => {
  log('stdin closed');
  process.exit(0);
});
