import net from 'node:net';
import { PgliteServerDatabase, createPostgresPool } from '@billme/server-data';

/**
 * A Postgres wire-protocol front for one PGlite instance, so the hosted
 * server-api and the server-worker (which only know `DATABASE_URL` and the
 * `pg` driver) run unchanged on an in-process Postgres.
 *
 * PGlite is one backend session. Connections are therefore served one at a
 * time: a connection owns the backend from its first message until the
 * backend reports idle (ReadyForQuery 'I'), so a transaction opened on one pool
 * client never sees statements of another. Real Postgres would let transactions
 * overlap; this is strictly more serial, never less.
 *
 * ponytail: because connections are serialized, serialization failures, row-lock
 * waits and deadlocks of a real Postgres are not reproduced here. Replace with a
 * real Postgres (docker-compose server mode, `pnpm test:e2e:server:*`) when those
 * need coverage.
 */
export type PgliteWire = {
  readonly url: string;
  readonly database: PgliteServerDatabase;
  /** Test-side SQL; goes through the same wire (and gate) as the product code. */
  readonly sql: <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: Row[] }>;
  /** Pool connections opened since start. */
  readonly connectionCount: () => number;
  /** Cut every open client connection, like a Postgres restart or failover; new connections are accepted again. */
  readonly dropConnections: () => void;
  readonly close: () => Promise<void>;
};

const SSL_REQUEST = 80877103;
const CANCEL_REQUEST = 80877102;

const message = (type: string, body: Buffer): Buffer => {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'latin1');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
};

const parameterStatus = (name: string, value: string): Buffer => message('S', Buffer.from(`${name}\0${value}\0`, 'utf8'));

const startupResponse = (): Buffer => {
  const authOk = Buffer.alloc(4);
  const keyData = Buffer.alloc(8);
  keyData.writeInt32BE(1, 0);
  keyData.writeInt32BE(1, 4);
  return Buffer.concat([
    message('R', authOk),
    parameterStatus('server_version', '16.4'),
    parameterStatus('client_encoding', 'UTF8'),
    parameterStatus('server_encoding', 'UTF8'),
    parameterStatus('DateStyle', 'ISO, MDY'),
    parameterStatus('integer_datetimes', 'on'),
    parameterStatus('standard_conforming_strings', 'on'),
    parameterStatus('TimeZone', 'UTC'),
    message('K', keyData),
    message('Z', Buffer.from('I')),
  ]);
};

/** Transaction status byte of the last ReadyForQuery in a backend response, if any. */
const lastReadyStatus = (response: Uint8Array): string | null => {
  let status: string | null = null;
  let offset = 0;
  while (offset + 5 <= response.length) {
    const type = String.fromCharCode(response[offset]!);
    const length = Buffer.from(response.buffer, response.byteOffset + offset + 1, 4).readInt32BE(0);
    if (type === 'Z') status = String.fromCharCode(response[offset + 5]!);
    offset += 1 + length;
  }
  return status;
};

class Gate {
  private holder: object | null = null;
  private readonly waiting: Array<() => void> = [];

  held(by: object): boolean { return this.holder === by; }

  async acquire(by: object): Promise<void> {
    while (this.holder && this.holder !== by) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.holder = by;
  }

  release(by: object): void {
    if (this.holder !== by) return;
    this.holder = null;
    this.waiting.shift()?.();
  }
}

// Frontend messages that end a request/response round trip.
const BOUNDARY = new Set(['Q', 'S', 'H', 'X']);

export const startPgliteWire = async (options: { dataDir?: string; migrate?: boolean } = {}): Promise<PgliteWire> => {
  const database = await PgliteServerDatabase.open(options.dataDir);
  if (options.migrate !== false) await database.migrate();
  const gate = new Gate();
  const sockets = new Set<net.Socket>();
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    const owner = {};
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let started = false;
    let work: Promise<unknown> = Promise.resolve();

    const pump = async (): Promise<void> => {
      for (;;) {
        if (!started) {
          if (pending.length < 8) return;
          const length = pending.readInt32BE(0);
          if (pending.length < length) return;
          const code = pending.readInt32BE(4);
          pending = pending.subarray(length);
          if (code === SSL_REQUEST) { socket.write('N'); continue; }
          if (code === CANCEL_REQUEST) { socket.destroy(); return; }
          started = true;
          socket.write(startupResponse());
          continue;
        }
        let offset = 0;
        let end = -1;
        let terminate = false;
        while (pending.length - offset >= 5) {
          const type = String.fromCharCode(pending[offset]!);
          const length = pending.readInt32BE(offset + 1);
          if (pending.length - offset < length + 1) break;
          offset += length + 1;
          if (BOUNDARY.has(type)) { end = offset; terminate = type === 'X'; break; }
        }
        if (end < 0) return;
        const batch = pending.subarray(0, end);
        pending = pending.subarray(end);
        if (terminate) { socket.end(); return; }
        await gate.acquire(owner);
        const response = await database.client.execProtocolRaw(new Uint8Array(batch));
        if (!socket.destroyed) socket.write(response);
        if (lastReadyStatus(response) === 'I') gate.release(owner);
      }
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      work = work.then(pump).catch(() => socket.destroy());
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      work = work.then(async () => {
        if (!gate.held(owner)) return;
        // The client vanished inside a transaction: do what a real server does.
        await database.client.execProtocolRaw(message('Q', Buffer.from('ROLLBACK\0'))).catch(() => undefined);
        gate.release(owner);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  let closed = false;
  const url = `postgresql://billme:billme@127.0.0.1:${port}/billme`;
  const testPool = createPostgresPool(url);
  return {
    url,
    database,
    sql: (text, values) => testPool.query(text, values) as never,
    connectionCount: () => connections,
    dropConnections: () => { for (const socket of sockets) socket.destroy(); },
    close: async () => {
      if (closed) return;
      closed = true;
      await testPool.end().catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close().catch(() => undefined);
    },
  };
};
