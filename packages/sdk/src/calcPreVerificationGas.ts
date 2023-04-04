import { UserOperationStruct } from '@account-abstraction/contracts'
import { NotPromise, packUserOp } from '@account-abstraction/utils'
import { arrayify, hexlify } from 'ethers/lib/utils'
const asL2Provider = require('@eth-optimism/sdk');
import { ethers } from 'ethers'
import { Provider } from '@ethersproject/providers'
import { ArbGasInfo__factory } from "@arbitrum/sdk/dist/lib/abi/factories/ArbGasInfo__factory";
import { ARB_GAS_INFO } from "@arbitrum/sdk/dist/lib/dataEntities/constants";
import Debug from 'debug'

const debug = Debug('cal preverification gas')

export interface GasOverheads {
  /**
   * fixed overhead for entire handleOp bundle.
   */
  fixed: number

  /**
   * per userOp overhead, added on top of the above fixed per-bundle.
   */
  perUserOp: number

  /**
   * overhead for userOp word (32 bytes) block
   */
  perUserOpWord: number

  // perCallDataWord: number

  /**
   * zero byte cost, for calldata gas cost calculations
   */
  zeroByte: number

  /**
   * non-zero byte cost, for calldata gas cost calculations
   */
  nonZeroByte: number

  /**
   * expected bundle size, to split per-bundle overhead between all ops.
   */
  bundleSize: number

  /**
   * expected length of the userOp signature.
   */
  sigSize: number
}

export const DefaultGasOverheads: GasOverheads = {
  fixed: 21000,
  perUserOp: 18300,
  perUserOpWord: 4,
  zeroByte: 4,
  nonZeroByte: 16,
  bundleSize: 1,
  sigSize: 65
}

/**
 * calculate the preVerificationGas of the given UserOperation
 * preVerificationGas (by definition) is the cost overhead that can't be calculated on-chain.
 * it is based on parameters that are defined by the Ethereum protocol for external transactions.
 * @param userOp filled userOp to calculate. The only possible missing fields can be the signature and preVerificationGas itself
 * @param overheads gas overheads to use, to override the default values
 */
export function calcPreVerificationGas (userOp: Partial<NotPromise<UserOperationStruct>>, overheads?: Partial<GasOverheads>): number {
  const ov = { ...DefaultGasOverheads, ...(overheads ?? {}) }
  const p: NotPromise<UserOperationStruct> = {
    // dummy values, in case the UserOp is incomplete.
    preVerificationGas: 21000, // dummy value, just for calldata cost
    signature: hexlify(Buffer.alloc(ov.sigSize, 1)), // dummy signature
    ...userOp
  } as any

  const packed = arrayify(packUserOp(p, false))
  const lengthInWord = (packed.length + 31) / 32
  const callDataCost = packed.map(x => x === 0 ? ov.zeroByte : ov.nonZeroByte).reduce((sum, x) => sum + x)
  const ret = Math.round(
    callDataCost +
    ov.fixed / ov.bundleSize +
    ov.perUserOp +
    ov.perUserOpWord * lengthInWord
  )
  return ret
}


/**
 * calculate the preVerificationGas(L1 & L2) of the given UserOperation
 * preVerificationGas (by definition) is the cost overhead that can't be calculated on-chain.
 * it is based on parameters that are defined by the Ethereum protocol for external transactions.
 * @param userOp filled userOp to calculate. The only possible missing fields can be the signature and preVerificationGas itself
 * @param provider current rpc provider
 */
export async function unifiedCalcPreVerificationGas (userOp: Partial<NotPromise<UserOperationStruct>>, provider: Provider, overheads?: Partial<GasOverheads>): Promise<number> {
  const network = await provider.getNetwork()
  // calc default PreVerification Gas
  const basePreVerificationGas = calcPreVerificationGas(userOp, overheads)
  //calc L1 calldata consumed gas on different L2 network(e.g Optimism, Arbitrum)
  if((network.name === "optimism-goerli" && network.chainId == 420) || (network.name === "optimism" && network.chainId == 10)) {
    return basePreVerificationGas + await calcL1GasOnOptimism(userOp, provider)
  }
  else if((network.name === "arbitrum-goerli" && network.chainId == 421613) || (network.name === "arbitrum" && network.chainId == 42161)) {
    return basePreVerificationGas + await calcL1GasOnArbitrum(userOp, provider)
  }
  else {
    return basePreVerificationGas
  }
}

export async function calcL1GasOnOptimism(userOp: Partial<NotPromise<UserOperationStruct>>, provider: Provider): Promise<number> {
 
    const l2RpcProvider = asL2Provider(provider)
    const l1BaseGasPrice = await l2RpcProvider.getL1GasPrice()
    const l2BasGasPrice = await provider.getGasPrice()

    const gasOnL1 = calcCalldataConsumedGasOnL1(userOp)
    const extraPreverificationGas = ethers.BigNumber.from(gasOnL1).mul(l1BaseGasPrice).div(l2BasGasPrice)
    debug("l1 gas price = ", l1BaseGasPrice, "l2 gas price =", l2BasGasPrice, "gas consumed on L1 =", gasOnL1, "extraPreverificationGas =", extraPreverificationGas)
    return extraPreverificationGas.toNumber()
}


export async function calcL1GasOnArbitrum(userOp: Partial<NotPromise<UserOperationStruct>>, provider: Provider): Promise<number> {
  const arbGasInfo = ArbGasInfo__factory.connect(
    ARB_GAS_INFO,
    provider
  );
  const gasComponents = await arbGasInfo.callStatic.getPricesInWei();

  const l2GasPrice = gasComponents[5];
  const l1GasPricePerByte = gasComponents[1];

  const p: NotPromise<UserOperationStruct> = {
    // dummy values, in case the UserOp is incomplete.
    preVerificationGas: 21000, // dummy value, just for calldata cost
    signature: hexlify(Buffer.alloc(65, 1)), // dummy signature
    ...userOp
  } as any

  const packed = arrayify(packUserOp(p, false))
  const userOpSize = 140 + ethers.utils.hexDataLength(packed);

  const feeOnL1 = l1GasPricePerByte.mul(userOpSize)
  const extraPreverificationGas = feeOnL1.div(l2GasPrice)
  debug("l1GasPricePerByte = ", l1GasPricePerByte, "l2 gas price = ", l2GasPrice, "gas consumed on L1 = ", feeOnL1, "extraPreverificationGas = ", extraPreverificationGas)
  return extraPreverificationGas.toNumber()
}

export function calcCalldataConsumedGasOnL1 (userOp: Partial<NotPromise<UserOperationStruct>>): number {
  const ov = { 
    fixed: 2100,
    perUserOp: 0,
    perUserOpWord: 4,
    zeroByte: 4,
    nonZeroByte: 16,
    bundleSize: 1,
    sigSize: 65}
  const p: NotPromise<UserOperationStruct> = {
    // dummy values, in case the UserOp is incomplete.
    preVerificationGas: 21000, // dummy value, just for calldata cost
    signature: hexlify(Buffer.alloc(ov.sigSize, 1)), // dummy signature
    ...userOp
  } as any

  const packed = arrayify(packUserOp(p, false))
  const lengthInWord = (packed.length + 31) / 32
  const callDataCost = packed.map(x => x === 0 ? ov.zeroByte : ov.nonZeroByte).reduce((sum, x) => sum + x)
  const ret = Math.round(
    callDataCost +
    ov.fixed / ov.bundleSize +
    ov.perUserOp +
    ov.perUserOpWord * lengthInWord
  )
  return ret
}
