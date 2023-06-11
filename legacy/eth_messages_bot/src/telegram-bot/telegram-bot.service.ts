import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { SimpleFallbackJsonRpcBatchProvider } from '@lido-nestjs/execution';
import { WordTokenizer } from 'natural';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wordnet = require('wordnet');

import { ConfigService } from 'src/common/config';
import { ExecutionProviderService } from 'src/common/execution-provider';

const tokenizer = new WordTokenizer();

const ignoreList = [
  'Ignore',
  'BFX_REFILL_SWEEP',
  'FA%}',
  'cs',
  'RM',
  'Rns_',
  'W8b%',
  '$AGI',
  'c',
  'Iŋ',
  'Fς#]',
  'DOGE.DOGE',
  '}M',
  'SWAP:',
  '=:RUNE',
  'DC-L5',
  ') ED',
];

@Injectable()
export class TelegramBotService {
  private readonly bot: Telegraf;

  private subscription: SimpleFallbackJsonRpcBatchProvider;
  public lastMessages: Record<string, string[]> = {};

  constructor(
    protected readonly executionProviderService: ExecutionProviderService,
    protected readonly configService: ConfigService,
  ) {
    this.bot = new Telegraf(this.configService.get('TELEGRAM_BOT_TOKEN'));
    this.initBot();
    this.ethBlockSubscribe();
  }
  private chatIds: number[] = [
    this.configService.get('DEFAULT_CHANNEL_ID')
      ? this.configService.get('DEFAULT_CHANNEL_ID')
      : undefined,
  ];

  private initBot = () => {
    this.bot.start((ctx) => {
      ctx.reply('Hello, I am a bot!');
    });

    this.bot.command('init', (ctx) => {
      if (this.chatIds.includes(ctx.chat.id)) return;
      this.chatIds.push(ctx.chat.id);
      ctx.reply('Done!');
    });

    this.bot.command('stop', (ctx) => {
      this.chatIds = this.chatIds.filter((id) => id !== ctx.chat.id);
      ctx.reply('Bye!');
    });

    this.bot.command('status', async (ctx) => {
      const status = await this.getSuscriptionStatus();
      ctx.reply(`Status: ${status}`);
    });

    this.bot.command('chats', async (ctx) => {
      const chatIds = this.getChatIds();
      ctx.reply(`Chat ids: ${chatIds}`);
    });

    this.bot.command('help', (ctx) => {
      const message =
        `/init - зарегистрировать чат для отправки уведомлений` +
        `\n/stop - не отправлять уведомления в текущий чат` +
        `\n/status - статус подписки на блоки` +
        `\n/chats - список чатов, которые получают уведомления`;

      return ctx.reply(message);
    });

    this.bot.launch();
  };

  public sendMessage = (message: string) => {
    this.chatIds.forEach((chatId) => {
      this.bot.telegram.sendMessage(chatId, message, {
        disable_web_page_preview: true,
      });
    });
  };

  private getSuscriptionStatus = async () => {
    const blockListeners = this.executionProviderService.listen('block');

    return blockListeners.length > 0;
  };

  private getChatIds = () => {
    return this.chatIds;
  };

  private ethBlockSubscribe = async () => {
    await wordnet.init();

    this.subscription = await this.executionProviderService.provider.on(
      'block',
      async (blockNumber) => {
        const block =
          await this.executionProviderService.provider.getBlockWithTransactions(
            blockNumber,
          );

        block.transactions.forEach(async (tx) => {
          const txText = await this.decodeBlockMessage(tx.data);
          if (!txText) return;

          if (!this.lastMessages[blockNumber]) this.lastMessages = {};

          this.lastMessages[blockNumber].push(txText);

          console.log('this.lastMessages', this.lastMessages);

          const message = this.createMessage(blockNumber, tx.hash, txText);
          this.sendMessage(message);
        });
      },
    );
  };

  private rememberMessages = (blockNumber: number, txText: string) => {
    if (Object.keys(this.lastMessages).length > 3) {
      delete this.lastMessages[Object.keys(this.lastMessages)[0]];
    }

    this.lastMessages[blockNumber].push(txText);
  };

  public getLastMessages = () => {
    const messages = Object.keys(this.lastMessages).map((blockNumber) => {
      return {
        blockNumber,
        messages: this.lastMessages[blockNumber],
      };
    });

    return messages;
  };

  private createMessage = (
    blockNumber: number,
    txHash: string,
    txText: string,
  ) => {
    return `
    New transaction received\nBlock # ${blockNumber}\nTx hash: ${txHash}\nEtherscan: https://etherscan.io/tx/${txHash}\nTx text: ${txText}
    ------------------------`;
  };

  private decodeBlockMessage = async (message: string) => {
    try {
      const decodedMessage = ethers.toUtf8String(message);
      if (ignoreList.includes(decodedMessage)) return null;

      const words = tokenizer.tokenize(decodedMessage);
      const isValid = await this.isMessageMeaningful(words);

      if (isValid) return decodedMessage;
      return null;
    } catch (error) {
      return null;
    }
  };

  private isMessageMeaningful = async (words: string[]) => {
    for (const word of words) {
      if (word.length < 2) continue;

      try {
        const synsets = await wordnet.lookup(word.toLowerCase());
        if (synsets.length > 0) return true;
      } catch (error) {
        continue;
      }
    }
  };
}
