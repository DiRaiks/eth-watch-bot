import { APP_GUARD } from '@nestjs/core';
import { MiddlewareConsumer, Module } from '@nestjs/common';

import { SWAGGER_URL } from './common/swagger';
import { ThrottlerModule, ThrottlerBehindProxyGuard } from './common/throttler';
import { LoggerMiddleware } from './common/middleware';
import { MessagesModule } from './messages';

@Module({
  imports: [ThrottlerModule, MessagesModule],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard }],
})
export class HTTPModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .exclude(`${SWAGGER_URL}/(.*)`, SWAGGER_URL)
      .forRoutes('*');
  }
}
