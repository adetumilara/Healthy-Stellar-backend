import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IpAllowlistGuard } from './ip-allowlist.guard';

function makeContext(ip: string, headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        socket: { remoteAddress: ip },
        headers,
      }),
    }),
  } as unknown as ExecutionContext;
}

async function buildGuard(allowlist: string): Promise<IpAllowlistGuard> {
  const module = await Test.createTestingModule({
    providers: [
      IpAllowlistGuard,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, def = '') =>
            key === 'ADMIN_IP_ALLOWLIST' ? allowlist : def,
          ),
        },
      },
    ],
  }).compile();
  return module.get(IpAllowlistGuard);
}

describe('IpAllowlistGuard', () => {
  describe('exact IP match', () => {
    it('allows a listed IP', async () => {
      const guard = await buildGuard('192.168.1.10,10.0.0.1');
      expect(guard.canActivate(makeContext('192.168.1.10'))).toBe(true);
    });

    it('blocks an unlisted IP', async () => {
      const guard = await buildGuard('192.168.1.10');
      expect(() => guard.canActivate(makeContext('192.168.1.99'))).toThrow(ForbiddenException);
    });
  });

  describe('CIDR range match', () => {
    it('allows an IP inside the CIDR range', async () => {
      const guard = await buildGuard('10.0.0.0/8');
      expect(guard.canActivate(makeContext('10.42.1.5'))).toBe(true);
    });

    it('blocks an IP outside the CIDR range', async () => {
      const guard = await buildGuard('10.0.0.0/8');
      expect(() => guard.canActivate(makeContext('172.16.0.1'))).toThrow(ForbiddenException);
    });

    it('allows an IP matching a /24 subnet', async () => {
      const guard = await buildGuard('192.168.1.0/24');
      expect(guard.canActivate(makeContext('192.168.1.200'))).toBe(true);
    });
  });

  describe('X-Forwarded-For header', () => {
    it('uses the first IP from X-Forwarded-For', async () => {
      const guard = await buildGuard('203.0.113.5');
      const ctx = makeContext('10.0.0.1', {
        'x-forwarded-for': '203.0.113.5, 10.0.0.1',
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('blocks when X-Forwarded-For IP is not allowlisted', async () => {
      const guard = await buildGuard('203.0.113.5');
      const ctx = makeContext('10.0.0.1', {
        'x-forwarded-for': '1.2.3.4, 10.0.0.1',
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });

  describe('X-Real-IP header', () => {
    it('uses X-Real-IP when X-Forwarded-For is absent', async () => {
      const guard = await buildGuard('203.0.113.7');
      const ctx = makeContext('10.0.0.1', { 'x-real-ip': '203.0.113.7' });
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('empty allowlist', () => {
    it('denies all requests when ADMIN_IP_ALLOWLIST is not set', async () => {
      const guard = await buildGuard('');
      expect(() => guard.canActivate(makeContext('127.0.0.1'))).toThrow(ForbiddenException);
    });
  });
});
