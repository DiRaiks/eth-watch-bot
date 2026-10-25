import {
  decodeAbiParameters,
  getAddress,
  hexToBigInt,
  slice,
  toEventSelector,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

/** Token events that show what happened to an address: transfers and approvals */
export const TOKEN_TOPICS = {
  transfer: toEventSelector('Transfer(address,address,uint256)'),
  approval: toEventSelector('Approval(address,address,uint256)'),
  approvalForAll: toEventSelector('ApprovalForAll(address,address,bool)'),
  transferSingle: toEventSelector(
    'TransferSingle(address,address,address,uint256,uint256)',
  ),
  transferBatch: toEventSelector(
    'TransferBatch(address,address,address,uint256[],uint256[])',
  ),
  // Uniswap Permit2: allowances granted by a signature, the usual phishing route
  permit2Approval: toEventSelector(
    'Approval(address,address,address,uint160,uint48)',
  ),
  permit2Permit: toEventSelector(
    'Permit(address,address,address,uint160,uint48,uint48)',
  ),
} as const;

/** Permit2 lives at the same address on every chain */
export const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');

export type RawLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hash;
  logIndex: number;
};

type LogBase = { token: Address; transactionHash: Hash; logIndex: number };

export type TokenLog = LogBase &
  (
    | { type: 'erc20'; from: Address; to: Address; value: bigint }
    | {
        type: 'nft';
        from: Address;
        to: Address;
        tokenIds: bigint[];
        /** ERC-1155 amounts per token id; null for ERC-721 */
        amounts: bigint[] | null;
      }
    /** ERC-20 allowance, also set by EIP-2612 permits */
    | { type: 'approval'; owner: Address; spender: Address; value: bigint }
    /** ERC-721 approval of one token */
    | {
        type: 'nft-approval';
        owner: Address;
        spender: Address;
        tokenId: bigint;
      }
    /** A Permit2 allowance: `spender` may move `token` of `owner` until `expiration` */
    | {
        type: 'permit2';
        owner: Address;
        /** The token the allowance is for; `token` of the log base is Permit2 itself */
        asset: Address;
        spender: Address;
        amount: bigint;
        /** Unix seconds */
        expiration: number;
      }
    /** ERC-721 / ERC-1155 operator for every token of the collection */
    | {
        type: 'approval-for-all';
        owner: Address;
        operator: Address;
        approved: boolean;
      }
  );

const topicAddress = (topic: Hex | undefined) => {
  if (!topic) throw new Error('missing topic');
  return getAddress(slice(topic, 12));
};

const topicNumber = (topic: Hex | undefined) => {
  if (!topic) throw new Error('missing topic');
  return hexToBigInt(topic);
};

const decode = (log: RawLog): TokenLog | null => {
  const base: LogBase = {
    token: getAddress(log.address),
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  };
  const [topic0, t1, t2, t3] = log.topics;

  switch (topic0) {
    case TOKEN_TOPICS.transfer:
      if (log.topics.length === 3) {
        const [value] = decodeAbiParameters([{ type: 'uint256' }], log.data);
        return {
          ...base,
          type: 'erc20',
          from: topicAddress(t1),
          to: topicAddress(t2),
          value,
        };
      }
      if (log.topics.length === 4) {
        return {
          ...base,
          type: 'nft',
          from: topicAddress(t1),
          to: topicAddress(t2),
          tokenIds: [topicNumber(t3)],
          amounts: null,
        };
      }
      return null;

    case TOKEN_TOPICS.approval:
      if (log.topics.length === 3) {
        const [value] = decodeAbiParameters([{ type: 'uint256' }], log.data);
        return {
          ...base,
          type: 'approval',
          owner: topicAddress(t1),
          spender: topicAddress(t2),
          value,
        };
      }
      if (log.topics.length === 4) {
        return {
          ...base,
          type: 'nft-approval',
          owner: topicAddress(t1),
          spender: topicAddress(t2),
          tokenId: topicNumber(t3),
        };
      }
      return null;

    case TOKEN_TOPICS.approvalForAll: {
      const [approved] = decodeAbiParameters([{ type: 'bool' }], log.data);
      return {
        ...base,
        type: 'approval-for-all',
        owner: topicAddress(t1),
        operator: topicAddress(t2),
        approved,
      };
    }

    case TOKEN_TOPICS.transferSingle: {
      const [id, value] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }],
        log.data,
      );
      return {
        ...base,
        type: 'nft',
        from: topicAddress(t2),
        to: topicAddress(t3),
        tokenIds: [id],
        amounts: [value],
      };
    }

    case TOKEN_TOPICS.transferBatch: {
      const [ids, values] = decodeAbiParameters(
        [{ type: 'uint256[]' }, { type: 'uint256[]' }],
        log.data,
      );
      return {
        ...base,
        type: 'nft',
        from: topicAddress(t2),
        to: topicAddress(t3),
        tokenIds: [...ids],
        amounts: [...values],
      };
    }

    case TOKEN_TOPICS.permit2Approval:
    case TOKEN_TOPICS.permit2Permit: {
      // Anyone can emit these events; only Permit2's own are allowances
      if (base.token !== PERMIT2) return null;
      const [amount, expiration] = decodeAbiParameters(
        [{ type: 'uint160' }, { type: 'uint48' }],
        log.data,
      );
      return {
        ...base,
        type: 'permit2',
        owner: topicAddress(t1),
        asset: topicAddress(t2),
        spender: topicAddress(t3),
        amount,
        expiration: Number(expiration),
      };
    }

    default:
      return null;
  }
};

/**
 * Cheap check before decoding: whether any indexed address of the log may be
 * watched. Busy blocks have thousands of logs and only a few matter.
 */
export const mayConcern = (
  log: Pick<RawLog, 'topics'>,
  isWatched: (address: Address) => boolean,
) =>
  log.topics
    .slice(1)
    .some((topic) => topic.length === 66 && isWatched(`0x${topic.slice(26)}`));

/** Decodes a token event; null for other events and for malformed ones (any contract can emit them) */
export const decodeTokenLog = (log: RawLog): TokenLog | null => {
  try {
    return decode(log);
  } catch {
    return null;
  }
};

/** Addresses whose activity the log shows */
export const logParties = (log: TokenLog): Address[] => {
  switch (log.type) {
    case 'erc20':
    case 'nft':
      return [log.from, log.to];
    case 'approval':
    case 'nft-approval':
      return [log.owner];
    case 'approval-for-all':
    case 'permit2':
      return [log.owner];
  }
};
