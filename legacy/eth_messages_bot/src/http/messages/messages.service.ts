import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';

import { ConfigService } from 'src/common/config';
import { TelegramBotService } from 'src/telegram-bot';

import { MessagesDto } from './dto';

@Injectable()
export class MessagesService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly configService: ConfigService,
    protected readonly telegramBotService: TelegramBotService,
  ) {}

  async getMessages(): Promise<MessagesDto | null> {
    return { blocks: this.telegramBotService.getLastMessages() };
  }
}
