import { Global, Module } from '@nestjs/common';
import { FallbackProviderModule } from '@lido-nestjs/execution';
import { NonEmptyArray } from '@lido-nestjs/execution/dist/interfaces/non-empty-array';
import { ConfigService } from 'src/common/config';
import { ExecutionProviderService } from './execution-provider.service';

@Global()
@Module({
  imports: [
    FallbackProviderModule.forRootAsync({
      async useFactory(configService: ConfigService) {
        const urls = configService.get('EL_RPC_URLS') as NonEmptyArray<string>;
        const network = configService.get('CHAIN_ID');

        return {
          urls,
          network,
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [ExecutionProviderService],
  exports: [ExecutionProviderService],
})
export class ExecutionProviderModule {}
