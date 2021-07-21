import { EventEmitter } from "events";
import * as http from "http"
import * as WebSocket from "ws";
import fastify, { FastifyInstance } from "fastify";
import helmet from "fastify-helmet";
import middiePlugin from "middie"
import ws from "fastify-websocket";
import pino, { Logger } from "pino";
import { getDefaultLoggerOptions, generateChildLogger } from "@pedrouid/pino-utils";
import * as pinoSentry from "pino-sentry";
import * as Sentry from "@sentry/node"
import { Severity as SentrySeverity } from "@sentry/types";
import client from "prom-client";

import config from "./config";
import { assertType, getRequestIP } from "./utils";
import { RedisService } from "./redis";
import { WebSocketService } from "./ws";
import { NotificationService } from "./notification";
import { HttpServiceOptions, PostSubscribeRequest } from "./types";
import {
  METRICS_DURACTION_BUCKETS,
  METRICS_PREFIX,
  SERVER_BEAT_INTERVAL,
  SERVER_CONTEXT,
  SERVER_EVENTS,
} from "./constants";
import { SubscriptionService } from "./subscription";
import { NetworkService } from "./network";
import { MessageService } from "./message";

export class HttpService {
  public events = new EventEmitter();

  public app: FastifyInstance;
  public logger: Logger;
  public redis: RedisService;

  public ws: WebSocketService;
  public network: NetworkService | undefined;
  public message: MessageService;
  public subscription: SubscriptionService;
  public notification: NotificationService;

  public context = SERVER_CONTEXT;

  public metrics;

  constructor(opts: HttpServiceOptions) {
    let logger: Logger
    if (typeof opts?.logger !== "undefined" && typeof opts?.logger !== "string") {
      logger = opts.logger
    } else if (process.env.SENTRY_DSN) {
      const stream = pinoSentry.createWriteStream({
        level: "warning",
      })
      logger = pino(getDefaultLoggerOptions({ level: opts?.logger }), stream)
    } else {
      logger = pino(getDefaultLoggerOptions({ level: opts?.logger }))
    }
    this.app = fastify({ logger });
    this.logger = generateChildLogger(logger, this.context);
    this.metrics = this.setMetrics();
    this.redis = new RedisService(this.logger);
    this.ws = new WebSocketService(this, this.logger);
    if (config.wakuUrl !== undefined) {
      this.network = new NetworkService(this, this.logger, config.wakuUrl);
    }
    this.message = new MessageService(this, this.logger);
    this.subscription = new SubscriptionService(this, this.logger);
    this.notification = new NotificationService(this, this.logger);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  public async initialize(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.registerMeta()
    await this.registerApi();
    this.setBeatInterval();
  }

  // ---------- Private ----------------------------------------------- //

  private async registerMeta() {
    await this.app.register(helmet)
    await this.app.register(middiePlugin)

    const sentryErrHandler = Sentry.Handlers.errorHandler()
    this.app
      .addHook('onError', (req, rep, err, done) => {
        sentryErrHandler(
          {
            name: err.name,
            message: err.message,
            statusCode: err.statusCode,
          },
          req.raw,
          rep.raw,
          err => done
        )
      })
      .use((req: http.IncomingMessage, res: http.ServerResponse, next: (error?: any) => void) => {
        Sentry.configureScope(scope => {
          scope.setUser({ ip_address: getRequestIP(req) })
        })
        next()
      })
      .use(Sentry.Handlers.requestHandler({
        flushTimeout: 2000
      }))
  }

  private async registerApi() {
    await this.app.register(ws, {
      options: genWsOptions()
    })

    this.app.get("/", { websocket: true }, (connection, req) => {
      req.headers
      connection.on("error", (e: Error) => {
        if (!e.message.includes("Invalid WebSocket frame")) {
          this.logger.fatal(e);
          throw e;
        }
      });
      this.ws.addNewSocket(connection.socket as any);
    });

    this.app.get("/health", (_, res) => {
      res.status(204).send();
    });

    this.app.get("/hello", (_, res) => {
      this.metrics.hello.inc();
      res
        .status(200)
        .send(`Hello World, this is Relay Server v${config.VERSION}@${config.GITHASH}`);
    });

    this.app.get("/mode", (_, res) => {
      res.status(200).send(`RELAY_MODE: ${config.mode}`);
    });

    this.app.get("/metrics", (_, res) => {
      res.headers({ "Content-Type": this.metrics.register.contentType });
      this.metrics.register.metrics().then(result => {
        res.status(200).send(result);
      });
    });

    this.app.post<PostSubscribeRequest>("/subscribe", async (req, res) => {
      try {
        assertType(req, "body", "object");

        assertType(req.body, "topic");
        assertType(req.body, "webhook");

        await this.notification.register(req.body.topic, req.body.webhook);

        res.status(200).send({ success: true });
      } catch (e) {
        res.status(400).send({ message: `Error: ${e.message}` });
      }
    });
  }

  private setMetrics() {
    const register = new client.Registry();

    client.collectDefaultMetrics({
      prefix: METRICS_PREFIX,
      register,
      gcDurationBuckets: METRICS_DURACTION_BUCKETS,
    });
    const metrics = {
      register,
      hello: new client.Counter({
        registers: [register],
        name: `${this.context}_hello_counter`,
        help: "shows how much the /hello has been called",
      }),
    };
    return metrics;
  }

  private setBeatInterval() {
    setInterval(() => this.events.emit(SERVER_EVENTS.beat), SERVER_BEAT_INTERVAL);
  }
}

function genWsOptions(): WebSocket.ServerOptions {
  const originSet: { [key: string]: boolean } = {};
  (process.env.INTERNAL_ORIGINS || '')
    .split(',')
    .map(o => originSet[o] = true)
  return {
    maxPayload: 500 * 1024,
    perMessageDeflate: true,
    verifyClient: ({ origin }): boolean => {
      if (!originSet[origin]) {
        Sentry.captureMessage("an external origin init websocket", {
          level: SentrySeverity.Warning,
        })
      }
      return true
    },
  }
}