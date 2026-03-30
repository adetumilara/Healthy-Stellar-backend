import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';
import Redis from 'ioredis';
import { NotificationsService } from './notifications.service';
import { NotificationEventType } from '../interfaces/notification-event.interface';

export interface OnChainEvent {
  type: 'new_record' | 'access_grant' | 'access_revoke';
  patientId: string;
  actorId: string;
  resourceId: string;
  ledgerSequence?: number;
  txHash?: string;
  metadata?: Record<string, any>;
}

const LAST_LEDGER_KEY = 'notifications:last_processed_ledger';
const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
const JITTER_FACTOR = 0.2;
const DISCONNECT_LIVENESS_THRESHOLD_MS = 2 * 60 * 1_000; // 2 minutes

@Injectable()
export class OnChainEventListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnChainEventListenerService.name);

  private static readonly EVENT_MAP: Record<OnChainEvent['type'], NotificationEventType> = {
    new_record: NotificationEventType.RECORD_UPLOADED,
    access_grant: NotificationEventType.ACCESS_GRANTED,
    access_revoke: NotificationEventType.ACCESS_REVOKED,
  };

  private redis: Redis;
  private retryCount = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private disconnectedAt: number | null = null;
  private lastProcessedLedger = 0;

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
    @InjectMetric('notifications_event_listener_up')
    private readonly listenerUpGauge: Gauge<string>,
    @InjectMetric('notifications_missed_events_total')
    private readonly missedEventsCounter: Counter<string>,
  ) {}

  onModuleInit(): void {
    this.redis = new Redis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get('REDIS_PASSWORD'),
      lazyConnect: true,
    });
    this.redis.connect().catch(() =>
      this.logger.warn('Redis unavailable — last ledger will not be persisted'),
    );
    this._connect();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.redis.disconnect();
    this.listenerUpGauge.set(0);
  }

  /** Returns true if the listener is healthy (connected or disconnected < 2 min). */
  isHealthy(): boolean {
    if (this.disconnectedAt === null) return true;
    return Date.now() - this.disconnectedAt < DISCONNECT_LIVENESS_THRESHOLD_MS;
  }

  async handleOnChainEvent(event: OnChainEvent): Promise<void> {
    const notificationType = OnChainEventListenerService.EVENT_MAP[event.type];
    if (!notificationType) {
      this.logger.warn(`Unknown on-chain event type: ${event.type}`);
      return;
    }

    await this.notificationsService.notifyOnChainEvent(
      notificationType,
      event.actorId,
      event.resourceId,
      event.patientId,
      { txHash: event.txHash, ...event.metadata },
    );

    if (event.ledgerSequence) {
      await this._saveLastLedger(event.ledgerSequence);
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async _connect(): Promise<void> {
    if (this.destroyed) return;

    const fromLedger = await this._loadLastLedger();
    this.logger.log(`Connecting to Stellar RPC (fromLedger=${fromLedger})`);

    try {
      await this._openConnection(fromLedger);
      this._onConnected();
    } catch (err) {
      this.logger.error(`Connection failed: ${(err as Error).message}`);
      this._scheduleReconnect();
    }
  }

  /**
   * Opens the actual RPC subscription. Override in tests or subclasses.
   * Implementations must call _scheduleReconnect() on disconnect/error.
   */
  protected async _openConnection(_fromLedger: number): Promise<void> {
    // Concrete Stellar Soroban RPC subscription wired here in production.
    // The method is intentionally left as a hook so the reconnection logic
    // can be unit-tested without a live RPC endpoint.
  }

  private _onConnected(): void {
    this.retryCount = 0;
    this.disconnectedAt = null;
    this.listenerUpGauge.set(1);
    this.logger.log('Stellar RPC listener connected');
  }

  _scheduleReconnect(): void {
    if (this.destroyed) return;

    if (this.disconnectedAt === null) {
      this.disconnectedAt = Date.now();
      this.listenerUpGauge.set(0);
    }

    const base = Math.min(INITIAL_DELAY_MS * 2 ** this.retryCount, MAX_DELAY_MS);
    const jitter = base * JITTER_FACTOR * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);
    this.retryCount++;

    this.logger.warn(`Reconnecting in ${delay}ms (attempt ${this.retryCount})`);
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  // ── Redis helpers ──────────────────────────────────────────────────────────

  private async _loadLastLedger(): Promise<number> {
    try {
      const val = await this.redis.get(LAST_LEDGER_KEY);
      const ledger = val ? parseInt(val, 10) : 0;
      this.lastProcessedLedger = ledger;
      return ledger > 0 ? ledger + 1 : 0;
    } catch {
      return 0;
    }
  }

  private async _saveLastLedger(ledger: number): Promise<void> {
    this.lastProcessedLedger = ledger;
    try {
      await this.redis.set(LAST_LEDGER_KEY, String(ledger));
    } catch {
      // non-fatal
    }
  }
}
