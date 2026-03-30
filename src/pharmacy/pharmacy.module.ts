import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { Drug } from './entities/drug.entity';
import { Prescription } from './entities/prescription.entity';
import { SafetyAlert } from './entities/safety-alert.entity';
import { PharmacyController } from './controllers/pharmacy.controller';
import { PharmacyService } from './services/pharmacy.service';
import { PrescriptionValidationService } from './services/prescription-validation.service';
import { PdmpService } from './services/pdmp.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Drug, Prescription, SafetyAlert]),
    HttpModule,
    ConfigModule,
  ],
  controllers: [PharmacyController],
  providers: [PharmacyService, PrescriptionValidationService, PdmpService],
  exports: [PharmacyService, PrescriptionValidationService],
})
export class PharmacyModule {}
