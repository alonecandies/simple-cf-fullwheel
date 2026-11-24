import { DurableObject } from "cloudflare:workers";
import type { Environment } from "../types";
import { errorType } from "../lib/logging";

interface PresenceEvent {
  type: "presence" | "new-note" | "share-card-ready";
  count: number;
}

const MAX_ACTIVE_CONNECTIONS = 100;

export class PresenceHub extends DurableObject<Environment> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast" && request.method === "POST") {
      let body: { type?: unknown };
      try {
        body = (await request.json()) as { type?: unknown };
      } catch {
        return new Response("Invalid event", { status: 400 });
      }
      if (body.type !== "new-note" && body.type !== "share-card-ready") {
        return new Response("Invalid event", { status: 400 });
      }
      await this.broadcast(body.type);
      return Response.json({ delivered: true });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const activeConnections = this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN).length;
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      return new Response("Live visitor capacity reached", {
        status: 503,
        headers: { "Retry-After": "30" },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    await this.broadcast("presence");

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketClose(
    _socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.broadcast("presence");
  }

  async webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    socket.close(1008, "This connection only receives guestbook updates");
  }

  async webSocketError(_socket: WebSocket, _error: unknown): Promise<void> {
    await this.broadcast("presence");
  }

  private async broadcast(type: PresenceEvent["type"]): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const count = sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
    const message = JSON.stringify({ type, count } satisfies PresenceEvent);

    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch (error) {
        console.warn("Could not update a guestbook visitor", errorType(error));
      }
    }
  }
}
