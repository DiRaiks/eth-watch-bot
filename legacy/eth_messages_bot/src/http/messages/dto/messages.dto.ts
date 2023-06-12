import { ApiProperty } from '@nestjs/swagger';

export class MessagesDto {
  @ApiProperty({
    example: {
      blockNumber: '123',
      messages: [{ message: 'Hello', hash: '0x123' }],
    },
    description: 'Messages',
  })
  blocks: {
    blockNumber: string;
    messages: { message: string; hash: string }[];
  }[];
}
