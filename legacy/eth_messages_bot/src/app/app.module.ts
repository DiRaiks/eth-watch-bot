import { Module } from '@nestjs/common';

import { ConfigModule } from 'src/common/config';
import { LoggerModule } from 'src/common/logger';
import { AppService } from './app.service';
import { HTTPModule } from '../http';

@Module({
  imports: [LoggerModule, HTTPModule, ConfigModule],
  providers: [AppService],
})
export class AppModule {}
