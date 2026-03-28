import { Args, Context, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { PatientsService } from '../../patients/patients.service';
import { PatientType } from '../types/schema.types';
import { RegisterPatientInput } from '../types/inputs';
import { GqlAuthGuard, GqlRoles, GqlRolesGuard, CurrentUser } from '../guards/gql-auth.guard';
import { DataLoaderService } from '../dataloaders/dataloader.service';

@Resolver(() => PatientType)
@UseGuards(GqlAuthGuard)
export class PatientResolver {
  constructor(private readonly patientsService: PatientsService) {}

  @Query(() => PatientType, { nullable: true })
  async patient(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: any,
  ): Promise<PatientType> {
    const loader: DataLoaderService = ctx.loaders;
    return loader.patients.load(id) as any;
  }

  @Query(() => [PatientType])
  @GqlRoles('admin', 'physician')
  @UseGuards(GqlRolesGuard)
  async patients(): Promise<PatientType[]> {
    const all = await this.patientsService.findAll({} as any);
    return (all?.data ?? []) as any;
  }

  @Mutation(() => PatientType)
  async registerPatient(
    @Args('input') input: RegisterPatientInput,
  ): Promise<PatientType> {
    return this.patientsService.create(input as any) as any;
  }
}
