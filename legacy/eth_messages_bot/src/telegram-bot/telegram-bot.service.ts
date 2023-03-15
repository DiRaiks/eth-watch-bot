import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { WordTokenizer } from 'natural';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wordnet = require('wordnet');

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
];

@Injectable()
export class TelegramBotService {
  private readonly bot: Telegraf;
  private chatIds: number[] = [
    process.env.DEFAULT_CHANNEL_ID
      ? Number(process.env.DEFAULT_CHANNEL_ID)
      : undefined,
  ];
  private provider: ethers.JsonRpcProvider;
  private subscription: ethers.JsonRpcProvider;

  constructor() {
    this.initProvider();
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.initBot();
    this.ethBlockSubscribe();
  }

  private initProvider = () => {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_PRIVIDER, 1);
  };

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
    const blockListeners = await this.provider.listeners('block');

    return blockListeners.length > 0;
  };

  private getChatIds = () => {
    return this.chatIds;
  };

  private ethBlockSubscribe = async () => {
    await wordnet.init();

    this.subscription = await this.provider.on('block', async (blockNumber) => {
      const block = await this.provider.getBlock(blockNumber, true);

      (
        block as ethers.Block &
          {
            prefetchedTransactions: ethers.TransactionResponse[]; // hack bad ethers types
          }[]
      ).prefetchedTransactions.forEach(async (tx) => {
        const txText = await this.decodeBlockMessage(tx.data);
        if (!txText) return;

        const message = `
          New transaction received\nBlock # ${blockNumber}\nTx hash: ${tx.hash}\nEtherscan: https://etherscan.io/tx/${tx.hash}\nTx text: ${txText}
          ------------------------`;
        this.sendMessage(message);
      });
    });
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
