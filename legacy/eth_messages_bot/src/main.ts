import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { ConfigService } from 'src/common/config';
import { SWAGGER_URL } from 'src/http/common/swagger';

import { AppModule, APP_DESCRIPTION, APP_VERSION } from './app';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      bufferLogs: true,
    },
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // config
  const configService: ConfigService = app.get(ConfigService);
  const environment = configService.get('NODE_ENV');
  const appPort = configService.get('PORT');
  const corsWhitelist = configService.get('CORS_WHITELIST_REGEXP');

  // cors
  if (corsWhitelist !== '') {
    const whitelistRegexp = new RegExp(corsWhitelist);

    app.enableCors({
      origin(origin, callback) {
        if (!origin || whitelistRegexp.test(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
    });
  }

  // versions
  app.enableVersioning({ type: VersioningType.URI });

  // logger
  app.useLogger(app.get(LOGGER_PROVIDER));

  // swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle(APP_DESCRIPTION)
    .setVersion(APP_VERSION)
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(SWAGGER_URL, app, swaggerDocument);

  // app
  await app.listen(appPort, '0.0.0.0');
}
bootstrap();
