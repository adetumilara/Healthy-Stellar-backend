import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PubSub } from 'graphql-subscriptions';
import { join } from 'path';

import { Patient } from '../patients/entities/patient.entity';
import { Record } from '../records/entities/record.entity';
import { AccessGrant } from '../access-control/entities/access-grant.entity';
import { User } from '../users/entities/user.entity';

import { RecordsModule } from '../records/records.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { UsersModule } from '../users/users.module';
import { PatientModule } from '../patients/patients.module';

import { GqlAuthGuard, GqlRolesGuard } from './guards/gql-auth.guard';
import { DataLoaderService } from './dataloaders/dataloader.service';
import { PatientResolver } from './resolvers/patient.resolver';
import { RecordsResolver } from './resolvers/records.resolver';
import { AccessGrantsResolver } from './resolvers/access-grants.resolver';
import { ProvidersResolver } from './resolvers/providers.resolver';
import { SubscriptionsResolver, PUB_SUB } from './resolvers/subscriptions.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([Patient, Record, AccessGrant, User]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get('JWT_SECRET', 'secret'),
        signOptions: { expiresIn: cfg.get('JWT_EXPIRES_IN', '7d') },
      }),
    }),
    RecordsModule,
    AccessControlModule,
    UsersModule,
    PatientModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const isProd = cfg.get('NODE_ENV') === 'production';
        return {
          autoSchemaFile: join(process.cwd(), 'docs/schema.graphql'),
          sortSchema: true,
          playground: !isProd,
          introspection: !isProd,
          subscriptions: {
            'graphql-ws': true,
            'subscriptions-transport-ws': true,
          },
          context: ({ req, extra }: any) => ({
            req: req ?? extra?.request,
            loaders: null, // populated per-request via REQUEST-scoped DataLoaderService
          }),
        };
      },
    }),
  ],
  providers: [
    { provide: PUB_SUB, useValue: new PubSub() },
    GqlAuthGuard,
    GqlRolesGuard,
    DataLoaderService,
    PatientResolver,
    RecordsResolver,
    AccessGrantsResolver,
    ProvidersResolver,
    SubscriptionsResolver,
  ],
  exports: [GqlAuthGuard, GqlRolesGuard, PUB_SUB],
})
export class GraphqlModule {}
