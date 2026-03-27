import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { Record } from './entities/record.entity';
import { RecordsController } from './controllers/records.controller';
import { RecordsService } from './services/records.service';
import { IpfsService } from './services/ipfs.service';
import { StellarService } from './services/stellar.service';
import { IpfsWithBreakerService } from './services/ipfs-with-breaker.service';
import { CircuitBreakerModule } from '../common/circuit-breaker/circuit-breaker.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { ProviderPatientModule } from '../provider-patient/provider-patient.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Record]),
    MulterModule.register({
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
      },
    }),
    CircuitBreakerModule,
    forwardRef(() => AccessControlModule),
    forwardRef(() => ProviderPatientModule),
  ],
  controllers: [RecordsController],
  providers: [RecordsService, IpfsService, StellarService, IpfsWithBreakerService],
  exports: [RecordsService, IpfsWithBreakerService],
})
export class RecordsModule {}
