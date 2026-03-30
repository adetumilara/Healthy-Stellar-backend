import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OnChainEventListenerService, OnChainEvent } from './on-chain-event-listener.service';
import { NotificationsService } from './notifications.service';
import { NotificationEventType } from '../interfaces/notification-event.interface';

jest.useFakeTimers();

const mockGauge = { set: jest.fn() };
const mockCounter = { inc: jest.fn() };

function buildRedis() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

async function createService() {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OnChainEventListenerService,
      {
        provide: NotificationsService,
        useValue: { notifyOnChainEvent: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      { provide: 'PROM_METRIC_NOTIFICATIONS_EVENT_LISTENER_UP', useValue: mockGauge },
      { provide: 'PROM_METRIC_NOTIFICATIONS_MISSED_EVENTS_TOTAL', useValue: mockCounter },
    ],
  }).compile();

  const service = module.get<OnChainEventListenerService>(OnChainEventListenerService);

  // Stub Redis and _openConnection so no real I/O happens
  (service as any).redis = buildRedis();
  jest.spyOn(service as any, '_openConnection').mockResolvedValue(undefined);

  return { service, module, notificationsService: module.get(NotificationsService) as jest.Mocked<NotificationsService> };
}

describe('OnChainEventListenerService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('handleOnChainEvent', () => {
    it('maps new_record → RECORD_UPLOADED', async () => {
      const { service, notificationsService } = await createService();
      const event: OnChainEvent = { type: 'new_record', patientId: 'p1', actorId: 'sys', resourceId: 'r1', txHash: 'tx1' };
      await service.handleOnChainEvent(event);
      expect(notificationsService.notifyOnChainEvent).toHaveBeenCalledWith(
        NotificationEventType.RECORD_UPLOADED, 'sys', 'r1', 'p1', expect.objectContaining({ txHash: 'tx1' }),
      );
    });

    it('maps access_grant → ACCESS_GRANTED', async () => {
      const { service, notificationsService } = await createService();
      await service.handleOnChainEvent({ type: 'access_grant', patientId: 'p1', actorId: 'doc1', resourceId: 'r1' });
      expect(notificationsService.notifyOnChainEvent).toHaveBeenCalledWith(
        NotificationEventType.ACCESS_GRANTED, 'doc1', 'r1', 'p1', expect.any(Object),
      );
    });

    it('maps access_revoke → ACCESS_REVOKED', async () => {
      const { service, notificationsService } = await createService();
      await service.handleOnChainEvent({ type: 'access_revoke', patientId: 'p1', actorId: 'doc1', resourceId: 'r1' });
      expect(notificationsService.notifyOnChainEvent).toHaveBeenCalledWith(
        NotificationEventType.ACCESS_REVOKED, 'doc1', 'r1', 'p1', expect.any(Object),
      );
    });

    it('warns and skips unknown event types', async () => {
      const { service, notificationsService } = await createService();
      await service.handleOnChainEvent({ type: 'unknown' as any, patientId: 'p1', actorId: 'sys', resourceId: 'r1' });
      expect(notificationsService.notifyOnChainEvent).not.toHaveBeenCalled();
    });

    it('persists ledgerSequence to Redis when provided', async () => {
      const { service } = await createService();
      const redis = (service as any).redis;
      await service.handleOnChainEvent({ type: 'new_record', patientId: 'p1', actorId: 'sys', resourceId: 'r1', ledgerSequence: 42 });
      expect(redis.set).toHaveBeenCalledWith('notifications:last_processed_ledger', '42');
    });
  });

  describe('reconnection logic', () => {
    it('schedules reconnect with exponential backoff on _scheduleReconnect()', () => {
      jest.spyOn(global, 'setTimeout');
      const { service } = require('./on-chain-event-listener.service');
      // Use a fresh instance via createService
      return createService().then(({ service }) => {
        service._scheduleReconnect();
        expect(setTimeout).toHaveBeenCalled();
        const [, delay] = (setTimeout as jest.Mock).mock.calls.at(-1)!;
        expect(delay).toBeGreaterThanOrEqual(800);   // 1000 * (1 - 0.2)
        expect(delay).toBeLessThanOrEqual(1200);     // 1000 * (1 + 0.2)
      });
    });

    it('doubles the base delay on each retry', async () => {
      jest.spyOn(global, 'setTimeout');
      const { service } = await createService();

      service._scheduleReconnect(); // attempt 1 — base 1s
      service._scheduleReconnect(); // attempt 2 — base 2s
      service._scheduleReconnect(); // attempt 3 — base 4s

      const delays = (setTimeout as jest.Mock).mock.calls.map(([, d]) => d);
      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });

    it('caps delay at 60 s', async () => {
      jest.spyOn(global, 'setTimeout');
      const { service } = await createService();
      (service as any).retryCount = 20; // force large exponent
      service._scheduleReconnect();
      const [, delay] = (setTimeout as jest.Mock).mock.calls.at(-1)!;
      expect(delay).toBeLessThanOrEqual(60_000 * 1.2); // max + max jitter
    });

    it('sets listenerUpGauge to 0 on first disconnect', async () => {
      const { service } = await createService();
      service._scheduleReconnect();
      expect(mockGauge.set).toHaveBeenCalledWith(0);
    });
  });

  describe('liveness probe', () => {
    it('isHealthy() returns true when connected', async () => {
      const { service } = await createService();
      (service as any).disconnectedAt = null;
      expect(service.isHealthy()).toBe(true);
    });

    it('isHealthy() returns true when disconnected < 2 min', async () => {
      const { service } = await createService();
      (service as any).disconnectedAt = Date.now() - 60_000;
      expect(service.isHealthy()).toBe(true);
    });

    it('isHealthy() returns false when disconnected >= 2 min', async () => {
      const { service } = await createService();
      (service as any).disconnectedAt = Date.now() - 2 * 60 * 1_000 - 1;
      expect(service.isHealthy()).toBe(false);
    });
  });
});
