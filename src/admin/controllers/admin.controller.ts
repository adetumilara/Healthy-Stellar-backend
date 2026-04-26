import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminModule } from '../admin.module';
import {
  ApiKeyService,
  CreateApiKeyDto,
  CreateApiKeyResponse,
  ApiKeyResponse,
} from '../../auth/services/api-key.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PolicyGuard } from '../../rbac/guards/policy.guard';
import { RequireAdmin } from '../../rbac/decorators/policy.decorator';
import { ApiKeyThrottlerGuard } from '../../common/throttler/api-key-throttler.guard';
import { IpAllowlistGuard } from '../../common/guards/ip-allowlist.guard';

@ApiTags('Admin - API Keys')
@Controller('admin/api-keys')
@UseGuards(IpAllowlistGuard, JwtAuthGuard, PolicyGuard)
@RequireAdmin()
@ApiBearerAuth()
export class AdminController {
  constructor(private apiKeyService: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({
    status: 201,
    description: 'API key created successfully',
    type: CreateApiKeyResponse,
  })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 409, description: 'API key name already exists' })
  async createApiKey(
    @Body() createDto: CreateApiKeyDto,
    @Req() req: Request,
  ): Promise<CreateApiKeyResponse> {
    const user = req.user as any; // From JWT guard
    return this.apiKeyService.createApiKey(
      createDto,
      user.id,
      this.getIpAddress(req),
      req.get('user-agent') || '',
    );
  }

  @Get()
  @ApiOperation({ summary: 'List all API keys' })
  @ApiResponse({
    status: 200,
    description: 'List of API keys',
    type: [ApiKeyResponse],
  })
  async listApiKeys(): Promise<ApiKeyResponse[]> {
    return this.apiKeyService.listApiKeys();
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 204, description: 'API key revoked successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async revokeApiKey(@Param('id') apiKeyId: string, @Req() req: Request): Promise<void> {
    const user = req.user as any; // From JWT guard
    await this.apiKeyService.revokeApiKey(
      apiKeyId,
      user.id,
      this.getIpAddress(req),
      req.get('user-agent') || '',
    );
  }

  private getIpAddress(req: Request): string {
    const forwarded = req.get('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || req.connection.remoteAddress || 'unknown';
  }
}
