import BigNumber from 'bignumber.js';
import { verify, hash } from '../utils/crypto';
import { encode, decode } from './builder/helpers';
import {
  PROTOCOL_VM_ABI, RawTxObject, TxSchema, TxParamsCommon, TX_TYPE, TxTypeSchemas, CtVersion,
} from './builder/schema';
import { TxUnpacked, unpackTx } from './builder';
import { UnsupportedProtocolError } from '../utils/errors';
import { concatBuffers, isKeyOfObject } from '../utils/other';
import { EncodedData } from '../utils/encoder';
import Node from '../Node';

interface Account {
  balance: bigint;
  id: EncodedData<'ak'>;
  nonce: number;
}

export interface ValidatorResult {
  message: string;
  key: string;
  checkedKeys: string[];
}

type Validator = (
  tx: {
    encodedTx: TxUnpacked<TxSchema>;
    signatures: Buffer[];
    tx: TxUnpacked<TxSchema> & {
      tx: TxTypeSchemas[TX_TYPE.signed];
    };
    nonce?: number;
    ttl?: number;
    amount?: number;
    fee?: number;
    nameFee?: number;
    ctVersion?: Partial<CtVersion>;
    abiVersion?: number;
    contractId?: EncodedData<'ct'>;
  },
  options: {
    account?: Account;
    nodeNetworkId: string;
    parentTxTypes: TX_TYPE[];
    node: Node;
    txType: TX_TYPE;
    height: number;
    consensusProtocolVersion: number;
  }
) => ValidatorResult[] | Promise<ValidatorResult[]>;

const validators: Validator[] = [];

const getSenderAddress = (
  tx: TxParamsCommon | RawTxObject<TxSchema>,
): EncodedData<'ak'> | undefined => [
  'senderId', 'accountId', 'ownerId', 'callerId',
  'oracleId', 'fromId', 'initiator', 'gaId', 'payerId',
]
  .map((key: keyof TxSchema) => tx[key])
  .filter((a) => a)
  .map((a) => a?.toString().replace(/^ok_/, 'ak_'))[0] as EncodedData<'ak'> | undefined;

/**
 * Transaction Validator
 * This function validates some of transaction properties,
 * to make sure it can be posted it to the chain
 * @category transaction builder
 * @param transaction - Base64Check-encoded transaction
 * @param node - Node to validate transaction against
 * @param parentTxTypes - Types of parent transactions
 * @returns Array with verification errors
 * @example const errors = await verifyTransaction(transaction, node)
 */
export default async function verifyTransaction(
  transaction: EncodedData<'tx' | 'pi'>,
  node: Node,
  parentTxTypes: TX_TYPE[] = [],
): Promise<ValidatorResult[]> {
  const { tx, txType } = unpackTx<TX_TYPE.signed>(transaction);
  const address = getSenderAddress(tx)
    ?? (txType === TX_TYPE.signed ? getSenderAddress(tx.encodedTx.tx) : undefined);
  const [account, { height }, { consensusProtocolVersion, nodeNetworkId }] = await Promise.all([
    address == null
      ? undefined
      : node.getAccountByPubkey(address)
        .catch(() => ({ id: address, balance: 0n, nonce: 0 }))
        // TODO: remove after fixing https://github.com/aeternity/aepp-sdk-js/issues/1537
        .then((acc) => ({ ...acc, id: acc.id as EncodedData<'ak'> })),
    node.getCurrentKeyBlockHeight(),
    node.getNodeInfo(),
  ]);

  return (await Promise.all(
    validators.map((v) => v(
      tx as any,
      {
        txType, node, account, height, consensusProtocolVersion, nodeNetworkId, parentTxTypes,
      },
    )),
  )).flat();
}

validators.push(
  ({ encodedTx, signatures }, { account, nodeNetworkId, parentTxTypes }) => {
    if ((encodedTx ?? signatures) === undefined) return [];
    if (account == null) return [];
    if (signatures.length !== 1) return []; // TODO: Support multisignature?
    const prefix = Buffer.from([
      nodeNetworkId,
      ...parentTxTypes.includes(TX_TYPE.payingFor) ? ['inner_tx'] : [],
    ].join('-'));
    const txWithNetworkId = concatBuffers([prefix, encodedTx.rlpEncoded]);
    const txHashWithNetworkId = concatBuffers([prefix, hash(encodedTx.rlpEncoded)]);
    const decodedPub = decode(account.id);
    if (verify(txWithNetworkId, signatures[0], decodedPub)
      || verify(txHashWithNetworkId, signatures[0], decodedPub)) return [];
    return [{
      message: 'Signature cannot be verified, please ensure that you transaction have'
        + ' the correct prefix and the correct private key for the sender address',
      key: 'InvalidSignature',
      checkedKeys: ['encodedTx', 'signatures'],
    }];
  },
  async ({ encodedTx, tx }, { node, parentTxTypes, txType }) => {
    if ((encodedTx ?? tx) === undefined) return [];
    return verifyTransaction(
      encode((encodedTx ?? tx).rlpEncoded, 'tx'),
      node,
      [...parentTxTypes, txType],
    );
  },
  ({ ttl }, { height }) => {
    if (ttl === undefined) return [];
    ttl = +ttl;
    if (ttl === 0 || ttl >= height) return [];
    return [{
      message: `TTL ${ttl} is already expired, current height is ${height}`,
      key: 'ExpiredTTL',
      checkedKeys: ['ttl'],
    }];
  },
  ({
    amount, fee, nameFee, tx,
  }, { account, parentTxTypes, txType }) => {
    if (account == null) return [];
    if ((amount ?? fee ?? nameFee) === undefined) return [];
    fee ??= 0;
    const cost = new BigNumber(fee).plus(nameFee ?? 0).plus(amount ?? 0)
      .plus(txType === TX_TYPE.payingFor ? (tx.tx.encodedTx.tx).fee : 0)
      .minus(parentTxTypes.includes(TX_TYPE.payingFor) ? fee : 0);
    if (cost.lte(account.balance.toString())) return [];
    return [{
      message: `Account balance ${account.balance.toString()} is not enough to execute the transaction that costs ${cost.toFixed()}`,
      key: 'InsufficientBalance',
      checkedKeys: ['amount', 'fee', 'nameFee'],
    }];
  },
  ({ nonce }, { account, parentTxTypes }) => {
    if (nonce == null || account == null || parentTxTypes.includes(TX_TYPE.gaMeta)) return [];
    nonce = +nonce;
    const validNonce = account.nonce + 1;
    if (nonce === validNonce) return [];
    return [{
      ...nonce < validNonce
        ? {
          message: `Nonce ${nonce} is already used, valid nonce is ${validNonce}`,
          key: 'NonceAlreadyUsed',
        }
        : {
          message: `Nonce ${nonce} is too high, valid nonce is ${validNonce}`,
          key: 'NonceHigh',
        },
      checkedKeys: ['nonce'],
    }];
  },
  ({ ctVersion, abiVersion }, { txType, consensusProtocolVersion }) => {
    if (!isKeyOfObject(consensusProtocolVersion, PROTOCOL_VM_ABI)) {
      throw new UnsupportedProtocolError(`Unsupported protocol: ${consensusProtocolVersion}`);
    }
    const protocol = PROTOCOL_VM_ABI[consensusProtocolVersion];

    // If not contract create tx
    if (ctVersion == null) ctVersion = { abiVersion };
    const txProtocol = protocol[txType as keyof typeof protocol];
    if (txProtocol == null) return [];
    if (Object.entries(ctVersion).some(
      ([
        key,
        value,
      ]: [
        key:keyof typeof txProtocol,
        value:any]) => !(txProtocol[key].includes(+value as never)),
    )) {
      return [{
        message: `ABI/VM version ${JSON.stringify(ctVersion)} is wrong, supported is: ${JSON.stringify(txProtocol)}`,
        key: 'VmAndAbiVersionMismatch',
        checkedKeys: ['ctVersion', 'abiVersion'],
      }];
    }
    return [];
  },
  async ({ contractId }, { txType, node }) => {
    if (TX_TYPE.contractCall !== txType) return [];
    contractId = contractId as EncodedData<'ct'>;
    try {
      const { active } = await node.getContract(contractId);
      if (active) return [];
      return [{
        message: `Contract ${contractId} is not active`,
        key: 'ContractNotActive',
        checkedKeys: ['contractId'],
      }];
    } catch (error) {
      if (error.response?.parsedBody?.reason == null) throw error;
      return [{
        message: error.response.parsedBody.reason,
        key: 'ContractNotFound',
        checkedKeys: ['contractId'],
      }];
    }
  },
);
