import { afterEach, expect, it, vi } from 'vitest';
import { MatchClient } from './matchClient';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('versucht bei einem Anmeldezeitlimit älterer Server erneut zu verbinden', async () => {
  vi.useFakeTimers();
  class FakeSocket {
    static OPEN = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    constructor(_url: string) { sockets.push(this); }
    send(_message: string) {}
    close() {}
  }
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  const client = new MatchClient('wss://example.test/match', 'fixture', { token: async () => 'token' });
  await client.connect();
  const socket = sockets[0]!;
  socket.onopen?.();
  socket.onmessage?.({ data: JSON.stringify({ t: 'error', message: 'Keine Anmeldung.', transient: false }) });
  socket.onclose?.({ code: 4001 });
  expect(client.state.connection).toBe('reconnecting');
  expect(client.state.error).toBeNull();
  await vi.advanceTimersByTimeAsync(6000);
  expect(sockets).toHaveLength(2);
  client.close();
});
