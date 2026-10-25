import { Module } from '@nestjs/common';
import { ConfigModule } from 'src/common/config';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

import { TelegramBotModule } from 'src/telegram-bot';

@Module({
  imports: [ConfigModule, TelegramBotModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
