import { EventEmitter } from "events";
import { Logger } from "pino";
import { IClient, IJsonRpcHistory, JsonRpcRecord, RequestEvent } from "@walletconnect/types";
import { ERROR } from "@walletconnect/utils";
import {
  formatJsonRpcRequest,
  isJsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@walletconnect/jsonrpc-utils";
import { generateChildLogger, getLoggerContext } from "@walletconnect/logger";

import { HISTORY_CONTEXT, HISTORY_EVENTS } from "../constants";

export class JsonRpcHistory extends IJsonRpcHistory {
  public records = new Map<number, JsonRpcRecord>();

  public events = new EventEmitter();

  public context: string = HISTORY_CONTEXT;

  private cached: JsonRpcRecord[] = [];

  constructor(public client: IClient, public logger: Logger) {
    super(client, logger);
    this.client;
    this.logger = generateChildLogger(logger, this.context);
    this.registerEventListeners();
  }

  public async init(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.restore();
  }

  get size(): number {
    return this.records.size;
  }

  get keys(): number[] {
    return Array.from(this.records.keys());
  }

  get values() {
    return Array.from(this.records.values());
  }

  get pending(): RequestEvent[] {
    const requests: RequestEvent[] = [];
    this.values.forEach(record => {
      if (typeof record.response !== "undefined") return;
      const requestEvent: RequestEvent = {
        topic: record.topic,
        request: formatJsonRpcRequest(record.request.method, record.request.params, record.id),
        chainId: record.chainId,
      };
      return requests.push(requestEvent);
    });
    return requests;
  }

  public async set(topic: string, request: JsonRpcRequest, chainId?: string): Promise<void> {
    await this.isEnabled();
    this.logger.debug(`Setting JSON-RPC request history record`);
    this.logger.trace({ type: "method", method: "set", topic, request, chainId });
    if (this.records.has(request.id)) {
      const error = ERROR.RECORD_ALREADY_EXISTS.format({
        context: this.getHistoryContext(),
        id: request.id,
      });
      this.logger.error(error.message);
      throw new Error(error.message);
    }
    const record: JsonRpcRecord = {
      id: request.id,
      topic,
      request: { method: request.method, params: request.params || null },
      chainId,
    };
    this.records.set(record.id, record);
    this.events.emit(HISTORY_EVENTS.created, record);
  }

  public async update(topic: string, response: JsonRpcResponse): Promise<void> {
    await this.isEnabled();
    this.logger.debug(`Updating JSON-RPC response history record`);
    this.logger.trace({ type: "method", method: "update", topic, response });
    if (!this.records.has(response.id)) return;
    const record = await this.getRecord(response.id);
    if (record.topic !== topic) return;
    if (typeof record.response !== "undefined") return;
    record.response = isJsonRpcError(response)
      ? { error: response.error }
      : { result: response.result };
    this.records.set(record.id, record);
    this.events.emit(HISTORY_EVENTS.updated, record);
  }

  public async get(topic: string, id: number): Promise<JsonRpcRecord> {
    await this.isEnabled();
    this.logger.debug(`Getting record`);
    this.logger.trace({ type: "method", method: "get", topic, id });
    const record = await this.getRecord(id);
    if (record.topic !== topic) {
      const error = ERROR.MISMATCHED_TOPIC.format({
        context: this.getHistoryContext(),
        id,
      });
      this.logger.error(error.message);
      throw new Error(error.message);
    }
    return record;
  }

  public async delete(topic: string, id?: number): Promise<void> {
    await this.isEnabled();
    this.logger.debug(`Deleting record`);
    this.logger.trace({ type: "method", method: "delete", id });
    this.values.forEach((record: JsonRpcRecord) => {
      if (record.topic === topic) {
        if (typeof id !== "undefined" && record.id !== id) return;
        this.records.delete(record.id);
        this.events.emit(HISTORY_EVENTS.deleted, record);
      }
    });
  }

  public async exists(topic: string, id: number): Promise<boolean> {
    await this.isEnabled();
    if (!this.records.has(id)) return false;
    const record = await this.getRecord(id);
    return record.topic === topic;
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

  // ---------- Private ----------------------------------------------- //

  private getNestedContext(length: number) {
    const nestedContext = getLoggerContext(this.logger).split("/");
    return nestedContext.slice(nestedContext.length - length, nestedContext.length);
  }

  private getHistoryContext() {
    return this.getNestedContext(2).join(" ");
  }

  private getStorageKey() {
    const storageKeyPrefix = `${this.client.protocol}@${this.client.version}:${this.client.context}`;
    const recordContext = this.getNestedContext(2).join(":");
    return `${storageKeyPrefix}//${recordContext}`;
  }

  private async getRecord(id: number): Promise<JsonRpcRecord> {
    await this.isEnabled();
    const record = this.records.get(id);
    if (!record) {
      const error = ERROR.NO_MATCHING_ID.format({
        context: this.getHistoryContext(),
        id,
      });
      this.logger.error(error.message);
      throw new Error(error.message);
    }
    return record;
  }

  private async persist() {
    await this.client.storage.setItem<JsonRpcRecord[]>(this.getStorageKey(), this.values);
    this.events.emit(HISTORY_EVENTS.sync);
  }

  private async restore() {
    try {
      const persisted = await this.client.storage.getItem<JsonRpcRecord[]>(this.getStorageKey());
      if (typeof persisted === "undefined") return;
      if (!persisted.length) return;
      if (this.records.size) {
        const error = ERROR.RESTORE_WILL_OVERRIDE.format({
          context: this.getHistoryContext(),
        });
        this.logger.error(error.message);
        throw new Error(error.message);
      }
      this.cached = persisted;
      await Promise.all(
        this.cached.map(async record => {
          this.records.set(record.id, record);
        }),
      );
      await this.enable();
      this.logger.debug(`Successfully Restored records for ${this.getHistoryContext()}`);
      this.logger.trace({ type: "method", method: "restore", records: this.values });
    } catch (e) {
      this.logger.debug(`Failed to Restore records for ${this.getHistoryContext()}`);
      this.logger.error(e);
    }
  }

  private async reset(): Promise<void> {
    await this.disable();
    await Promise.all(
      this.cached.map(async record => {
        this.records.set(record.id, record);
      }),
    );
    await this.enable();
  }

  private async isEnabled(): Promise<void> {
    if (!this.cached.length) return;
    return new Promise(resolve => {
      this.events.once(HISTORY_EVENTS.enabled, () => resolve());
    });
  }

  private async enable(): Promise<void> {
    this.cached = [];
    this.events.emit(HISTORY_EVENTS.enabled);
  }

  private async disable(): Promise<void> {
    if (!this.cached.length) {
      this.cached = this.values;
    }
    this.events.emit(HISTORY_EVENTS.disabled);
  }

  private registerEventListeners(): void {
    this.events.on(HISTORY_EVENTS.created, (record: JsonRpcRecord) => {
      const eventName = HISTORY_EVENTS.created;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, record });
      this.persist();
    });
    this.events.on(HISTORY_EVENTS.updated, (record: JsonRpcRecord) => {
      const eventName = HISTORY_EVENTS.updated;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, record });
      this.persist();
    });

    this.events.on(HISTORY_EVENTS.deleted, (record: JsonRpcRecord) => {
      const eventName = HISTORY_EVENTS.deleted;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, record });
      this.persist();
    });
  }
}
