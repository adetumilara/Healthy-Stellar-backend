import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { AnalyticsService } from './analytics.service';
import { User } from '../users/entities/user.entity';
import { MedicalRecord } from '../medical-records/entities/medical-record.entity';
import { AccessGrant, GrantStatus } from '../access-control/entities/access-grant.entity';
import { StellarTransaction } from './entities/stellar-transaction.entity';

// ─── getOverview — REPEATABLE READ transaction tests ─────────────────────────

describe('AnalyticsService — getOverview', () => {
  let service: AnalyticsService;
  let cache: { get: jest.Mock; set: jest.Mock };
  let txCallback: jest.Mock;

  function makeDataSource(counts: {
    users: number;
    records: number;
    grants: number;
    activeGrants: number;
    stellar: number;
  }) {
    const emRepo = (n: number) => ({ count: jest.fn().mockResolvedValue(n) });

    const em = {
      getRepository: jest.fn((entity: any) => {
        if (entity === User) return emRepo(counts.users);
        if (entity === MedicalRecord) return emRepo(counts.records);
        if (entity === StellarTransaction) return emRepo(counts.stellar);
        // AccessGrant — first call = total, second = active
        let callIdx = 0;
        return {
          count: jest.fn().mockImplementation(() =>
            callIdx++ === 0
              ? Promise.resolve(counts.grants)
              : Promise.resolve(counts.activeGrants),
          ),
        };
      }),
    };

    txCallback = jest.fn().mockImplementation((_isolation: string, cb: (em: any) => any) =>
      cb(em),
    );

    return { transaction: txCallback };
  }

  async function build(
    counts = { users: 10, records: 50, grants: 20, activeGrants: 8, stellar: 5 },
    cachedValue: any = null,
  ) {
    cache = {
      get: jest.fn().mockResolvedValue(cachedValue),
      set: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(MedicalRecord), useValue: {} },
        { provide: getRepositoryToken(AccessGrant), useValue: {} },
        { provide: getRepositoryToken(StellarTransaction), useValue: {} },
        { provide: CACHE_MANAGER, useValue: cache },
        { provide: getDataSourceToken(), useValue: makeDataSource(counts) },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  }

  it('returns correct counts from the transactional snapshot', async () => {
    await build({ users: 10, records: 50, grants: 20, activeGrants: 8, stellar: 5 });
    const result = await service.getOverview();
    expect(result.totalUsers).toBe(10);
    expect(result.totalRecords).toBe(50);
    expect(result.totalAccessGrants).toBe(20);
    expect(result.activeGrants).toBe(8);
    expect(result.stellarTransactions).toBe(5);
  });

  it('includes a lastUpdatedAt ISO timestamp', async () => {
    await build();
    const result = await service.getOverview();
    expect(result.lastUpdatedAt).toBeDefined();
    expect(new Date(result.lastUpdatedAt).getTime()).not.toBeNaN();
  });

  it('opens the transaction with REPEATABLE READ isolation', async () => {
    await build();
    await service.getOverview();
    expect(txCallback).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
  });

  it('returns cached result without opening a transaction on cache hit', async () => {
    const cached = {
      totalUsers: 99, totalRecords: 999, totalAccessGrants: 50,
      activeGrants: 30, stellarTransactions: 10,
      lastUpdatedAt: new Date().toISOString(),
    };
    await build(undefined, cached);
    const result = await service.getOverview();
    expect(result).toEqual(cached);
    expect(txCallback).not.toHaveBeenCalled();
  });

  it('caches the result with a 60-second TTL on cache miss', async () => {
    await build();
    await service.getOverview();
    expect(cache.set).toHaveBeenCalledWith(
      'analytics:overview',
      expect.objectContaining({ totalUsers: 10 }),
      60,
    );
  });

  it('does not call cache.set on a cache hit', async () => {
    const cached = {
      totalUsers: 1, totalRecords: 1, totalAccessGrants: 1,
      activeGrants: 1, stellarTransactions: 1,
      lastUpdatedAt: new Date().toISOString(),
    };
    await build(undefined, cached);
    await service.getOverview();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('handles all-zero counts (empty platform)', async () => {
    await build({ users: 0, records: 0, grants: 0, activeGrants: 0, stellar: 0 });
    const result = await service.getOverview();
    expect(result.totalUsers).toBe(0);
    expect(result.totalRecords).toBe(0);
    expect(result.activeGrants).toBe(0);
  });
});

// ─── getActivity / getTopProviders (preserved) ───────────────────────────────

describe('AnalyticsService — getActivity & getTopProviders', () => {
  let service: AnalyticsService;
  let medicalRecordRepository: any;
  let accessGrantRepository: any;

  beforeEach(async () => {
    const mockRepository = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(User), useValue: mockRepository },
        { provide: getRepositoryToken(MedicalRecord), useValue: mockRepository },
        { provide: getRepositoryToken(AccessGrant), useValue: mockRepository },
        { provide: getRepositoryToken(StellarTransaction), useValue: mockRepository },
        { provide: CACHE_MANAGER, useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    medicalRecordRepository = module.get(getRepositoryToken(MedicalRecord));
    accessGrantRepository = module.get(getRepositoryToken(AccessGrant));
  });

  describe('getActivity', () => {
    it('should return daily activity with record uploads and access events', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-01-03');

      const mockRecordQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { date: '2024-01-01T00:00:00.000Z', count: '5' },
          { date: '2024-01-02T00:00:00.000Z', count: '3' },
        ]),
      };

      const mockAccessQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { date: '2024-01-01T00:00:00.000Z', count: '2' },
          { date: '2024-01-03T00:00:00.000Z', count: '4' },
        ]),
      };

      medicalRecordRepository.createQueryBuilder.mockReturnValueOnce(mockRecordQueryBuilder);
      accessGrantRepository.createQueryBuilder.mockReturnValueOnce(mockAccessQueryBuilder);

      const result = await service.getActivity(from, to);

      expect(result.dailyActivity).toHaveLength(3);
      expect(result.dailyActivity[0]).toEqual({ date: '2024-01-01', recordUploads: 5, accessEvents: 2 });
      expect(result.dailyActivity[1]).toEqual({ date: '2024-01-02', recordUploads: 3, accessEvents: 0 });
      expect(result.dailyActivity[2]).toEqual({ date: '2024-01-03', recordUploads: 0, accessEvents: 4 });
    });

    it('should return zero counts for days with no activity', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-01-02');

      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      medicalRecordRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      accessGrantRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getActivity(from, to);

      expect(result.dailyActivity).toHaveLength(2);
      expect(result.dailyActivity[0]).toEqual({ date: '2024-01-01', recordUploads: 0, accessEvents: 0 });
      expect(result.dailyActivity[1]).toEqual({ date: '2024-01-02', recordUploads: 0, accessEvents: 0 });
    });

    it('should handle single day date range', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-01-01');

      const mockRecordQb = {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ date: '2024-01-01T00:00:00.000Z', count: '10' }]),
      };
      const mockAccessQb = {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ date: '2024-01-01T00:00:00.000Z', count: '7' }]),
      };

      medicalRecordRepository.createQueryBuilder.mockReturnValueOnce(mockRecordQb);
      accessGrantRepository.createQueryBuilder.mockReturnValueOnce(mockAccessQb);

      const result = await service.getActivity(from, to);

      expect(result.dailyActivity).toHaveLength(1);
      expect(result.dailyActivity[0]).toEqual({ date: '2024-01-01', recordUploads: 10, accessEvents: 7 });
    });
  });

  describe('getTopProviders', () => {
    it('should return providers ranked by active grant count', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { providerId: 'provider-1', activeGrantCount: '15' },
          { providerId: 'provider-2', activeGrantCount: '10' },
          { providerId: 'provider-3', activeGrantCount: '5' },
        ]),
      };

      accessGrantRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTopProviders();

      expect(result.providers).toHaveLength(3);
      expect(result.providers[0]).toEqual({ providerId: 'provider-1', activeGrantCount: 15 });
      expect(result.providers[1]).toEqual({ providerId: 'provider-2', activeGrantCount: 10 });
      expect(result.providers[2]).toEqual({ providerId: 'provider-3', activeGrantCount: 5 });
    });

    it('should return empty array when no active grants exist', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(), getRawMany: jest.fn().mockResolvedValue([]),
      };

      accessGrantRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const result = await service.getTopProviders();
      expect(result.providers).toEqual([]);
    });

    it('should filter only active grants', async () => {
      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ providerId: 'provider-1', activeGrantCount: '8' }]),
      };

      accessGrantRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder);
      await service.getTopProviders();

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'grant.status = :status',
        { status: 'ACTIVE' },
      );
    });
  });
});
