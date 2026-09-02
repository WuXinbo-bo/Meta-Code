import type { Response } from "express";

export type WorkbenchEvent = {
  id: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
  audienceUserIds?: string[];
};

const MAX_BUFFERED_EVENTS = 2_000;
const MAX_PENDING_EVENTS = 256;

type EventClient = {
  response: Response;
  userId?: string;
  blocked: boolean;
  pending: WorkbenchEvent[];
};

export class WorkbenchEventHub {
  // Keep IDs ahead of values retained by browsers across server restarts.
  private sequence = Date.now() * 1_000;
  private events: WorkbenchEvent[] = [];
  private clients = new Map<Response, EventClient>();

  publish(type: string, data: Record<string, unknown>, audienceUserIds?: string[]) {
    const event: WorkbenchEvent = {
      id: ++this.sequence,
      type,
      data,
      createdAt: new Date().toISOString(),
      audienceUserIds: audienceUserIds?.length ? [...new Set(audienceUserIds)] : undefined
    };
    this.events.push(event);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.splice(0, this.events.length - MAX_BUFFERED_EVENTS);
    for (const client of this.clients.values()) {
      if (!this.visibleTo(event, client.userId)) continue;
      this.send(client, event);
    }
    return event;
  }

  subscribe(response: Response, afterId = 0, userId?: string) {
    const client: EventClient = { response, userId, blocked: false, pending: [] };
    this.clients.set(response, client);
    // afterId=0 is a fresh subscription, not a request to replay the complete
    // in-memory history. Replays are only for a browser resuming a known ID.
    if (afterId > 0) for (const event of this.events) {
      if (!this.clients.has(response)) break;
      if (event.id > afterId && this.visibleTo(event, userId)) this.send(client, event);
    }
    const oldestEventId = this.events[0]?.id || 0;
    const latestEventId = this.events.at(-1)?.id || 0;
    const replayComplete = afterId === 0 || (oldestEventId > 0 && afterId >= oldestEventId - 1 && afterId <= latestEventId);
    if (this.clients.has(response)) {
      try {
        if (this.writeControl(response, "stream.ready", { afterId, oldestEventId, latestEventId, replayComplete }) === false) {
          client.blocked = true;
          response.once("drain", () => this.flush(client));
        }
      }
      catch { this.drop(client); }
    }
    return () => this.clients.delete(response);
  }

  heartbeat(response: Response) {
    const client = this.clients.get(response);
    if (!client || client.blocked) return;
    try {
      if (this.writeControl(response, "stream.heartbeat", { sentAt: new Date().toISOString() }) === false) {
        client.blocked = true;
        response.once("drain", () => this.flush(client));
      }
    }
    catch { this.drop(client); }
  }

  private write(response: Response, event: WorkbenchEvent) {
    return response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  private writeControl(response: Response, type: string, data: Record<string, unknown>) {
    return response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private send(client: EventClient, event: WorkbenchEvent) {
    if (client.blocked) {
      client.pending.push(event);
      if (client.pending.length > MAX_PENDING_EVENTS) this.drop(client);
      return;
    }
    try {
      if (this.write(client.response, event) !== false) return;
      client.blocked = true;
      client.response.once("drain", () => this.flush(client));
    } catch { this.drop(client); }
  }

  private flush(client: EventClient) {
    if (!this.clients.has(client.response)) return;
    client.blocked = false;
    while (client.pending.length) {
      const event = client.pending.shift()!;
      try {
        if (this.write(client.response, event) !== false) continue;
        client.blocked = true;
        client.response.once("drain", () => this.flush(client));
        return;
      } catch { this.drop(client); return; }
    }
  }

  private drop(client: EventClient) {
    this.clients.delete(client.response);
    try { client.response.end(); } catch { /* Connection is already gone. */ }
  }

  private visibleTo(event: WorkbenchEvent, userId?: string) {
    return !event.audienceUserIds?.length || Boolean(userId && event.audienceUserIds.includes(userId));
  }
}
