import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';

import { ExecutionProviderModule } from '../common/execution-provider';
import { ConfigModule } from '../common/config';

@Module({
  imports: [ExecutionProviderModule, ConfigModule],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
