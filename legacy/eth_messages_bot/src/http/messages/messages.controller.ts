import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  HttpStatus,
  UseInterceptors,
  Version,
  CacheTTL,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { MessagesService } from './messages.service';
import { MessagesDto } from './dto';

@Controller('messages')
@ApiTags('Messages')
@UseInterceptors(ClassSerializerInterceptor)
export class MessagesController {
  constructor(protected readonly messagesService: MessagesService) {}

  @Version('1')
  @Get('/')
  @Throttle(30, 10)
  @CacheTTL(10)
  @ApiResponse({ status: HttpStatus.OK, type: MessagesDto })
  async messagesV1(): Promise<MessagesDto | null> {
    return this.messagesService.getMessages();
  }
}
