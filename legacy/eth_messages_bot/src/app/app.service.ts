import {
  Inject,
  Injectable,
  LoggerService,
  OnModuleInit,
} from '@nestjs/common';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';

import { ConfigService } from 'src/common/config';
import { ExecutionProviderService } from 'src/common/execution-provider';
import { APP_NAME, APP_VERSION } from './app.constants';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,

    protected readonly configService: ConfigService,
    protected readonly executionProviderService: ExecutionProviderService,
  ) {}

  public async onModuleInit(): Promise<void> {
    await this.validateNetwork();

    const network = await this.executionProviderService.getNetworkName();
    const env = this.configService.get('NODE_ENV');
    const version = APP_VERSION;
    const name = APP_NAME;

    this.logger.log('Init app', { env, network, name, version });
  }

  /**
   * Validates the EL chains match
   */
  protected async validateNetwork(): Promise<void> {
    const chainId = this.configService.get('CHAIN_ID');
    const elChainId = await this.executionProviderService.getChainId();

    if (chainId !== elChainId) {
      throw new Error('Chain ids do not match');
    }
  }
}
