import { Module } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramBotModule {}
