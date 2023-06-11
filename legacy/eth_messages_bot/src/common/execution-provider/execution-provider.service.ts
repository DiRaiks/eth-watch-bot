import { SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { CHAINS } from '@lido-nestjs/constants';
import { Injectable } from '@nestjs/common';
import { Listener } from 'ethers';

@Injectable()
export class ExecutionProviderService {
  constructor(readonly provider: SimpleFallbackJsonRpcBatchProvider) {}

  /**
   * Returns network name
   */
  public async getNetworkName(): Promise<string> {
    const network = await this.provider.getNetwork();
    const name = CHAINS[network.chainId]?.toLocaleLowerCase();
    return name || network.name;
  }

  /**
   * Returns current chain id
   */
  public async getChainId(): Promise<number> {
    const { chainId } = await this.provider.getNetwork();
    return chainId;
  }

  public listen(eventName: string): Listener[] {
    return this.provider.listeners(eventName);
  }
}
