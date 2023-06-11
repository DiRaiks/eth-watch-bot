import { ApiProperty } from '@nestjs/swagger';

export class MessagesDto {
  @ApiProperty({
    example: { blockNumber: '123', messages: ['message1', 'message2'] },
    description: 'Messages',
  })
  blocks: {
    blockNumber: string;
    messages: string[];
  }[];
}
