import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { McpLaunch } from '../providers/types';
import type { NestTools } from './tools';

/**
 * Local IPC endpoint the Nest MCP server (spawned by Codex / Claude Code)
 * connects to. Each conversation gets an unguessable token that identifies it,
 * so a tool call can only act as the conversation it was launched for.
 */
export class NestBridge {
  readonly endpoint: string;
  private server: net.Server | null = null;
  private tokenToConversation = new Map<string, string>();
  private conversationToToken = new Map<string, string>();

  constructor(
    private readonly tools: NestTools,
    private readonly serverScript: string,
    private readonly nodeCommand: string = process.execPath,
  ) {
    const id = `nest-${process.pid}-${randomBytes(6).toString('hex')}`;
    this.endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.serve(socket));
      server.once('error', reject);
      server.listen(this.endpoint, () => {
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (process.platform !== 'win32') rmSync(this.endpoint, { force: true });
  }

  /** How the provider should launch the MCP server for this conversation. */
  launchFor(conversationId: string): McpLaunch | null {
    if (!this.server) return null;
    let token = this.conversationToToken.get(conversationId);
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.conversationToToken.set(conversationId, token);
      this.tokenToConversation.set(token, conversationId);
    }
    return {
      command: this.nodeCommand,
      args: [this.serverScript],
      env: { ELECTRON_RUN_AS_NODE: '1', NEST_BRIDGE: this.endpoint, NEST_TOKEN: token },
    };
  }

  private serve(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 4 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        void this.handle(socket, line);
      }
    });
    socket.on('error', () => {});
  }

  private async handle(socket: net.Socket, line: string): Promise<void> {
    let msg: { id?: number; token?: string; tool?: string; args?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (payload: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: msg.id, ...payload })}\n`);
    };
    const conversationId = msg.token ? this.tokenToConversation.get(msg.token) : undefined;
    if (!conversationId) {
      reply({ ok: false, text: 'Not authorised: this tool server was not started by Nest for this conversation.' });
      return;
    }
    if (msg.tool === '__list') {
      reply({ ok: true, text: '', tools: this.tools.listFor(conversationId) });
      return;
    }
    try {
      const res = await this.tools.call(conversationId, String(msg.tool ?? ''), msg.args);
      reply({ ok: res.ok, text: res.text, ...(res.image ? { image: res.image } : {}) });
    } catch (err) {
      reply({ ok: false, text: `Nest error: ${(err as Error).message}` });
    }
  }
}
