import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { FeatureFlagService, UpsertFeatureFlagDto } from './feature-flag.service';

@ApiTags('feature-flags')
@ApiBearerAuth()
@Controller('admin/feature-flags')
export class FeatureFlagController {
  constructor(private readonly service: FeatureFlagService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  upsert(@Body() dto: UpsertFeatureFlagDto, @Req() req: any) {
    return this.service.upsert(dto, req.user?.id ?? 'system');
  }

  @Patch(':key/rollback')
  rollback(@Param('key') key: string, @Req() req: any) {
    return this.service.rollback(key, req.user?.id ?? 'system');
  }
}
