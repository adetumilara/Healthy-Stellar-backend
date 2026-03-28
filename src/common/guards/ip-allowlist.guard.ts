import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as ipaddr from 'ipaddr.js';

@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IpAllowlistGuard.name);
  private readonly allowlist: string[];

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>('ADMIN_IP_ALLOWLIST', '');
    this.allowlist = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  canActivate(context: ExecutionContext): boolean {
    // If no allowlist configured, deny all (fail-secure)
    if (this.allowlist.length === 0) {
      throw new ForbiddenException('Admin access not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const clientIp = this.extractIp(req);

    if (!clientIp || !this.isAllowed(clientIp)) {
      this.logger.warn(`Admin access denied for IP: ${clientIp}`);
      throw new ForbiddenException('Access denied');
    }

    return true;
  }

  private extractIp(req: Request): string | null {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')[0]
        .trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }
    return req.ip ?? req.socket?.remoteAddress ?? null;
  }

  private isAllowed(clientIp: string): boolean {
    let parsed: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsed = ipaddr.process(clientIp); // normalises IPv4-mapped IPv6
    } catch {
      return false;
    }

    for (const entry of this.allowlist) {
      try {
        if (entry.includes('/')) {
          const [range, bits] = ipaddr.parseCIDR(entry);
          const candidate = ipaddr.process(clientIp);
          // Both must be same kind for matchCIDR
          if (candidate.kind() === range.kind() && candidate.match(range, bits)) {
            return true;
          }
        } else {
          if (parsed.toString() === ipaddr.process(entry).toString()) {
            return true;
          }
        }
      } catch {
        this.logger.warn(`Invalid allowlist entry ignored: ${entry}`);
      }
    }

    return false;
  }
}
