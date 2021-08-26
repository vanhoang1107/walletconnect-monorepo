import { Logger } from "pino";
import client from "prom-client";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";
import { isJsonRpcPayload, JsonRpcPayload } from "@walletconnect/jsonrpc-utils";
import { generateChildLogger } from "@walletconnect/logger";
import * as Sentry from "@sentry/node"
import { SpanStatus } from "@sentry/tracing"

import config from "./config";
import { JsonRpcService } from "./jsonrpc";
import { LegacySocketMessage, Socket } from "./types";
import {
  generateRandomBytes32,
  isJsonRpcDisabled,
  isLegacyDisabled,
  isLegacySocketMessage,
} from "./utils";

import { LegacyService } from "./legacy";
import { HttpService } from "./http";
import { SERVER_EVENTS, WEBSOCKET_CONTEXT, WEBSOCKET_EVENTS } from "./constants";

export class WebSocketService {
  public jsonrpc: JsonRpcService;
  public legacy: LegacyService;
  public sockets = new Map<string, Socket>();

  public context = WEBSOCKET_CONTEXT;

  private metrics;

  constructor(public server: HttpService, public logger: Logger) {
    this.server = server;
    this.logger = generateChildLogger(logger, this.context);
    this.jsonrpc = new JsonRpcService(this.server, this.logger);
    this.legacy = new LegacyService(this.server, this.logger);
    this.metrics = {
      newConnection: new client.Counter({
        name: `${this.server.context}_${this.context}_new_connections`,
        help: "Sum of opened ws connection",
        registers: [this.server.metrics.register],
      }),
      closeConnection: new client.Counter({
        name: `${this.server.context}_${this.context}_closed_connections`,
        help: "Sum of closed ws connections",
        registers: [this.server.metrics.register],
      }),
      totalMessages: new client.Counter({
        name: `${this.server.context}_${this.context}_messages_total`,
        help: "Total amount of messages",
        registers: [this.server.metrics.register],
      }),
    };

    this.initialize();
  }

  public close(): void {
    this.sockets.forEach((s, id) => {
      s.close(1012) // Service Restart
    })
  }

  public send(socketId: string, msg: string | JsonRpcPayload | LegacySocketMessage): boolean {
    const socket = this.getSocket(socketId);
    if (typeof socket === "undefined") return false;
    const message = typeof msg === "string" ? msg : safeJsonStringify(msg);
    this.logger.debug(`Outgoing Socket Message`);
    this.logger.trace({ type: "message", direction: "outgoing", message });
    socket.send(message);
    return true;
  }

  public getSocket(socketId: string): Socket | undefined {
    const socket = this.sockets.get(socketId);
    if (typeof socket === "undefined") {
      this.logger.error(`Socket not found with socketId: ${socketId}`);
      return;
    }
    return socket;
  }

  public isSocketConnected(socketId: string): boolean {
    try {
      const socket = this.getSocket(socketId);
      if (typeof socket == "undefined") return false;
      return socket.readyState === 1;
    } catch (e) {
      return false;
    }
  }

  public addNewSocket(socket: Socket) {
    const socketId = generateRandomBytes32();
    this.metrics.newConnection.inc();
    this.logger.info(`New Socket Connected`);
    this.logger.debug({ type: "event", event: "connection", socketId });
    this.sockets.set(socketId, socket);
    this.server.events.emit(WEBSOCKET_EVENTS.open, socketId);

    let sentryTxn = Sentry.startTransaction({
      name: `WS bridge`,
      op: 'open',
      sampled: true,
      status: SpanStatus.Ok,
    })
    socket.on("message", async data => {
      this.metrics.totalMessages.inc();

      const span = sentryTxn.startChild({ op: "handle message" })
      const message = data.toString();
      this.logger.debug(`Incoming Socket Message`);
      this.logger.trace({ type: "message", direction: "incoming", message });

      try {
        if (!message || !message.trim()) {
          this.send(socketId, "Missing or invalid socket data");
          span.status = SpanStatus.InvalidArgument
          return;
        }
        const payload = safeJsonParse(message);
        if (typeof payload === "string") {
          this.send(socketId, "Socket message is invalid");
          span.status = SpanStatus.InvalidArgument
          return;
        }
        if (isLegacySocketMessage(payload)) {
          if (isLegacyDisabled(config.mode)) {
            this.send(socketId, "Legacy messages are disabled");
            span.status = SpanStatus.Unavailable
            return;
          }
          this.legacy.onRequest(socketId, payload, span)
          return
        }
        if (isJsonRpcPayload(payload)) {
          if (isJsonRpcDisabled(config.mode)) {
            this.send(socketId, "JSON-RPC messages are disabled");
            span.status = SpanStatus.Unavailable
            return;
          }
          this.jsonrpc.onPayload(socketId, payload, span);
          return
        }
        this.send(socketId, "Socket message unsupported");
        span.status = SpanStatus.Unimplemented
        return
      } finally {
        span.finish()
      }
    });

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("error", (e: Error) => {
      if (!e.message.includes("Invalid WebSocket frame")) {
        this.logger.fatal(e);
        throw e;
      }
      this.logger.error({ "Socket Error": e.message });
    });

    socket.on("close", () => {
      const nowUnix = new Date().getTime() / 1000
      if (nowUnix - sentryTxn.startTimestamp < 5) {
        sentryTxn.sampled = false
      }
      sentryTxn.finish()
      this.metrics.closeConnection.inc();
      this.sockets.delete(socketId);
      this.server.events.emit(WEBSOCKET_EVENTS.close, socketId);
    });
  }

  // ---------- Private ----------------------------------------------- //

  private initialize(): void {
    this.logger.trace(`Initialized`);
    this.registerEventListeners();
  }

  private registerEventListeners() {
    this.server.events.on(SERVER_EVENTS.beat, () => this.clearInactiveSockets());
  }

  private clearInactiveSockets() {
    const socketIds = Array.from(this.sockets.keys());
    socketIds.forEach((socketId: string) => {
      const socket = this.sockets.get(socketId);

      if (typeof socket === "undefined") {
        return;
      }
      if (socket.isAlive === false) {
        this.sockets.delete(socketId);
        socket.terminate();
        this.server.events.emit(WEBSOCKET_EVENTS.close, socketId);
        return;
      }

      function noop() {
        // empty
      }

      socket.isAlive = false;
      socket.ping(noop);
    });
  }
}
