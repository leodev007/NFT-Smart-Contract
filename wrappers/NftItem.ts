import { Op } from './NftConstants';
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, DictionaryValue, Sender, SendMode, toNano, internal as internal_relaxed, storeMessageRelaxed, Slice } from '@ton/core';


export class NftItem implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new NftItem(address);
    }

    static transferMessage(to: Address, response: Address | null, forwardAmount: bigint = 1n,  forwardPayload?: Cell | Slice | null,  queryId: bigint | number = 0) {
        const byRef = forwardPayload instanceof Cell
        const body = beginCell()
                .storeUint(Op.transfer, 32)
                .storeUint(queryId, 64)
                .storeAddress(to)
                .storeAddress(response)
                .storeBit(false) // No custom payload
                .storeCoins(forwardAmount)
                .storeBit(byRef)
        if(byRef) {
            body.storeRef(forwardPayload)
        } else if(forwardPayload) {
            body.storeSlice(forwardPayload)
        }
        return body.endCell();
    }

    async sendTransfer(provider: ContractProvider, via: Sender, to: Address, response: Address | null, forwardAmount: bigint = 1n, forwardPayload?: Cell | Slice | null,  value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        if(value <= forwardAmount) {
            throw Error("Value has to exceed forwardAmount");
        }
        await provider.internal(via, {
            value,
            body: NftItem.transferMessage(to, response, forwardAmount, forwardPayload, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    static staticDataMessage(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.get_static_data, 32)
                .storeUint(queryId, 64)
               .endCell();
    }

    async sendGetStaticData(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftItem.staticDataMessage(queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async getNftData(provider: ContractProvider) {
        const { stack } = await provider.get('get_nft_data', []);

        return {
            isInit: stack.readBoolean(),
            index: stack.readNumber(),
            collection: stack.readAddress(),
            owner: stack.readAddressOpt(),
            content: stack.readCellOpt()
        }
    }

}
