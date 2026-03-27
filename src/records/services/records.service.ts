import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, Between, DataSource } from 'typeorm';
import { Record } from '../entities/record.entity';
import { CreateRecordDto } from '../dto/create-record.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { PaginatedRecordsResponseDto, PaginationMeta } from '../dto/paginated-response.dto';
import { IpfsService } from './ipfs.service';
import { StellarService } from './stellar.service';
import { AccessControlService } from '../../access-control/services/access-control.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { ProviderPatientRelationshipService } from '../../provider-patient/services/provider-patient-relationship.service';

@Injectable()
export class RecordsService {
  constructor(
    @InjectRepository(Record)
    private recordRepository: Repository<Record>,
    private dataSource: DataSource,
    private ipfsService: IpfsService,
    private stellarService: StellarService,
    @Inject(forwardRef(() => AccessControlService))
    private accessControlService: AccessControlService,
    private auditLogService: AuditLogService,
    @Inject(forwardRef(() => ProviderPatientRelationshipService))
    private providerPatientService: ProviderPatientRelationshipService,
  ) {}

  async uploadRecord(
    dto: CreateRecordDto,
    encryptedBuffer: Buffer,
    providerId?: string,
  ): Promise<{ recordId: string; cid: string; stellarTxHash: string }> {
    const cid = await this.ipfsService.upload(encryptedBuffer);
    const stellarTxHash = await this.stellarService.anchorCid(dto.patientId, cid);

    return this.dataSource.transaction(async (manager) => {
      const record = manager.create(Record, {
        patientId: dto.patientId,
        cid,
        stellarTxHash,
        recordType: dto.recordType,
        description: dto.description,
      });

      const savedRecord = await manager.save(record);

      if (providerId) {
        await manager.query(
          `INSERT INTO provider_patient_relationships
             ("providerId", "patientId", "firstInteractionAt", "recordCount")
           VALUES ($1, $2, NOW(), 1)
           ON CONFLICT ("providerId", "patientId")
           DO UPDATE SET
             "recordCount" = provider_patient_relationships."recordCount" + 1`,
          [providerId, dto.patientId],
        );
      }

      return {
        recordId: savedRecord.id,
        cid: savedRecord.cid,
        stellarTxHash: savedRecord.stellarTxHash,
      };
    });
  }

  async findAll(query: PaginationQueryDto): Promise<PaginatedRecordsResponseDto> {
    const {
      page = 1,
      limit = 20,
      recordType,
      fromDate,
      toDate,
      sortBy = 'createdAt',
      order = 'desc',
      patientId,
    } = query;

    // Build where clause
    const where: FindOptionsWhere<Record> = {};

    if (recordType) {
      where.recordType = recordType;
    }

    if (patientId) {
      where.patientId = patientId;
    }

    if (fromDate && toDate) {
      where.createdAt = Between(new Date(fromDate), new Date(toDate));
    } else if (fromDate) {
      where.createdAt = Between(new Date(fromDate), new Date());
    } else if (toDate) {
      where.createdAt = Between(new Date(0), new Date(toDate));
    }

    // Calculate pagination
    const skip = (page - 1) * limit;

    // Execute query
    const [data, total] = await this.recordRepository.findAndCount({
      where,
      order: {
        [sortBy]: order.toUpperCase(),
      },
      take: limit,
      skip,
    });

    // Calculate metadata
    const totalPages = Math.ceil(total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    const meta: PaginationMeta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage,
      hasPreviousPage,
    };

    return {
      data,
      meta,
    };
  }

  async findOne(id: string, requesterId?: string): Promise<Record> {
    const record = await this.recordRepository.findOne({ where: { id } });
    
    if (record && requesterId) {
      const emergencyGrant = await this.accessControlService.findActiveEmergencyGrant(
        record.patientId,
        requesterId,
        id,
      );

      if (emergencyGrant) {
        await this.auditLogService.create({
          operation: 'EMERGENCY_ACCESS',
          entityType: 'records',
          entityId: id,
          userId: requesterId,
          status: 'success',
          newValues: {
            patientId: record.patientId,
            grantId: emergencyGrant.id,
            recordId: id,
          },
        });
      }
    }
    
    return record;
  }
}
