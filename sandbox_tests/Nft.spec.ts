import { Blockchain, SandboxContract, TreasuryContract, BlockchainSnapshot } from '@ton/sandbox';
import { Cell, toNano, beginCell } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress, getRandomInt } from './utils';
import { NewNftItem, NftCollection, nftContentToCell } from '../wrappers/NftCollection';
import { NftItem } from '../wrappers/NftItem';
import { Op, Errors } from '../wrappers/NftConstants';
import { computedGeneric, computeMessageForwardFees, getMsgPrices } from './gasUtils';
import { findTransactionRequired } from '@ton/test-utils';

describe('NFT', () => {
    let collection_code = new Cell();
    let item_code = new Cell();
    let blockchain: Blockchain;
    let deployer:SandboxContract<TreasuryContract>;
    let royaltyWallet:SandboxContract<TreasuryContract>;

    let nftCollection: SandboxContract<NftCollection>;
    let commonContent: string;
    let royaltyFactor: number;
    let royaltyBase: number;

    let initialState: BlockchainSnapshot;
    let itemsDeployedState: BlockchainSnapshot;
    let itemNotInitedState: BlockchainSnapshot;

    let nftItemByIdx: (idx: number | bigint) => Promise<SandboxContract<NftItem>>;

    beforeAll(async () => {
        collection_code = await compile('NftCollection');
        item_code       = await compile('NftItem');
        blockchain = await Blockchain.create();

        blockchain.now = 1000;

        deployer       = await blockchain.treasury('deployer', {workchain: 0});
        royaltyWallet  = await blockchain.treasury('Royalty$toMe');
        royaltyFactor  = getRandomInt(10, 50); // From 1 to 5 percent
        royaltyBase    = 1000;


        commonContent  = 'https://raw.githubusercontent.com/Trinketer22/token-contract/main/nft/web-example/'
        nftCollection  = blockchain.openContract(
            NftCollection.createFromConfig({
                admin: deployer.address,
                item_code,
                content: {type: 'offchain', uri:'https://raw.githubusercontent.com/Trinketer22/token-contract/main/nft/web-example/my_collection.json'},
                common_content: commonContent,
                royalty: {
                    address: royaltyWallet.address,
                    royalty_factor: royaltyFactor,
                    royalty_base: royaltyBase
                }
            }, collection_code)
        );

        const deployRes = await nftCollection.sendDeploy(deployer.getSender(), toNano('1'));

        expect(deployRes.transactions).toHaveTransaction({
            on: nftCollection.address,
            aborted: false,
            deploy: true
        });

        nftItemByIdx = async (idx) => blockchain.openContract(
            NftItem.createFromAddress(
                await nftCollection.getNftAddressByIndex(idx)
            )
        );

        initialState = blockchain.snapshot();
    });

    beforeEach(async () => await blockchain.loadFrom(initialState));

    describe('Collection', () => {
    it('collection should deploy', async () => {
        const collectionData = await nftCollection.getCollectionData();
        expect(collectionData.owner).toEqualAddress(deployer.address);
        expect(collectionData.nextItemIndex).toBe(0);
    });

    it('admin should be able to deploy item', async () => {
        const collData = await nftCollection.getCollectionData();
        let   curIdx   = collData.nextItemIndex;

        const iterCount = getRandomInt(5, 10);

        for(let i = 0; i < iterCount; i++) {
            let    nextItem = await nftItemByIdx(curIdx);
            let   itemOwner = i == 0 ? deployer.address : randomAddress(0);
            const itemContentCell = nftContentToCell({type: 'offchain', uri: `my_nft_${i}.json`});

            const res = await nftCollection.sendDeployItem(deployer.getSender(), {
                owner: itemOwner,
                content: itemContentCell
            }, curIdx);

            expect(res.transactions).toHaveTransaction({
                on: nextItem.address,
                from: nftCollection.address,
                aborted: false,
                deploy: true
            });


            const itemData = await nextItem.getNftData();
            expect(itemData.collection).toEqualAddress(nftCollection.address);
            expect(itemData.owner).toEqualAddress(itemOwner);
            expect(itemData.index).toEqual(curIdx);
            expect(itemData.content).toEqualCell(itemContentCell);

            const dataAfter = await nftCollection.getCollectionData();
            expect(dataAfter.nextItemIndex).toEqual(++curIdx);
        }

        itemsDeployedState = blockchain.snapshot();
    });

    it('non-admin should not be able to deploy new items', async () => {
        for(let testState of [initialState, itemsDeployedState]) {
            await blockchain.loadFrom(testState);
            const dataBefore = await nftCollection.getCollectionData();

            const res = await nftCollection.sendDeployItem(royaltyWallet.getSender(), {
                owner: royaltyWallet.address,
                content: { type: 'offchain', uri: 'my_nft.json' }
            }, dataBefore.nextItemIndex);

            expect(res.transactions).toHaveTransaction({
                on: nftCollection.address,
                from: royaltyWallet.address,
                op: Op.deploy_item,
                aborted: true,
                exitCode: Errors.invalid_sender
            });
        }
    });
    it('should not be able to mint item with index above expected', async () => {
        for(let testState of [initialState, itemsDeployedState]) {
            await blockchain.loadFrom(testState);
            const dataBefore = await nftCollection.getCollectionData();
            for(let i = 0; i < 10; i++) {
                const mintIdx    = i == 0 ? dataBefore.nextItemIndex + 1 : dataBefore.nextItemIndex + getRandomInt(2, 10000);
                const res = await nftCollection.sendDeployItem(deployer.getSender(), {
                    owner: deployer.address,
                    content: { type: 'offchain', uri: 'my_nft.json' },
                }, mintIdx);
                expect(res.transactions).toHaveTransaction({
                    on: nftCollection.address,
                    from: deployer.address,
                    op: Op.deploy_item,
                    aborted: true,
                    exitCode: Errors.invalid_index
                });
            }
        }
    });
    it('owner should be able to batch mint items', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const nextIdx = (await nftCollection.getCollectionData()).nextItemIndex;
        const lastIdx = nextIdx + 100;

        let items: {item: NewNftItem, index: number | bigint, forwardAmount: bigint}[] = [];

        for(let i = nextIdx; i < lastIdx; i++) {
            items.push({
                index: i,
                item: {
                    owner: randomAddress(0),
                    content: { type: 'offchain', uri: `my_${i}_nft.json` }
                },
                forwardAmount: toNano('0.05'),
            });
        }

        const res = await nftCollection.sendDeployBatch(deployer.getSender(), items, toNano('6'));

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            outMessagesCount: 100
        });

        const dataAfter = await nftCollection.getCollectionData();
        expect(dataAfter.nextItemIndex).toEqual(lastIdx);

        for(let testItem of items) {
            const itemContract = await nftItemByIdx(testItem.index);
            const itemData = await itemContract.getNftData();

            expect(itemData.isInit).toBe(true);
            expect(testItem.item.owner).toEqualAddress(itemData.owner!);
            expect(itemData.content).toEqualCell(testItem.item.content instanceof Cell ? testItem.item.content : nftContentToCell(testItem.item.content));
        }
    });
    it('not owner should not be able to batch mint', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const nextIdx = (await nftCollection.getCollectionData()).nextItemIndex;
        const lastIdx = nextIdx + 100;

        let items: {item: NewNftItem, index: number | bigint, forwardAmount: bigint}[] = [];

        for(let i = nextIdx; i < lastIdx; i++) {
            items.push({
                index: i,
                item: {
                    owner: randomAddress(0),
                    content: { type: 'offchain', uri: `my_${i}_nft.json` }
                },
                forwardAmount: toNano('0.05'),
            });
        }

        const res = await nftCollection.sendDeployBatch(royaltyWallet.getSender(), items, toNano('6'));
        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: royaltyWallet.address,
            op: Op.batch_deploy_item,
            aborted: true,
            exitCode: Errors.invalid_sender,
        });
    });
    it('batch mint should reject index above expected', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const nextIdx = (await nftCollection.getCollectionData()).nextItemIndex;
        const lastIdx = nextIdx + 2;

        let items: {item: NewNftItem, index: number | bigint, forwardAmount: bigint}[] = [];

        for(let i = nextIdx; i < lastIdx; i++) {
            items.push({
                index: i,
                item: {
                    owner: randomAddress(0),
                    content: { type: 'offchain', uri: `my_${i}_nft.json` }
                },
                forwardAmount: toNano('0.05'),
            });
        }

        const badIdx = lastIdx + 2;
        items.push({
            index: badIdx,
            item: {
                owner: randomAddress(0),
                content: { type: 'offchain', uri: `my_${lastIdx + 2}_nft.json`}
            },
            forwardAmount: toNano('0.05')
        });

        const res = await nftCollection.sendDeployBatch(deployer.getSender(), items, toNano('1'));

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.batch_deploy_item,
            aborted: true,
            exitCode: Errors.invalid_batch_index + 3 // Error + record count
        });

    });
    it('collection owner should be able to change owner', async () => {
        const dataBefore = await nftCollection.getCollectionData();
        const newOwner = randomAddress(0);

        expect(dataBefore.owner).toEqualAddress(deployer.address);
        const res = await nftCollection.sendChangeOwner(deployer.getSender(), newOwner);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            op: Op.change_owner,
            aborted: false
        });

        const dataAfter = await nftCollection.getCollectionData();

        expect(dataAfter.owner).toEqualAddress(newOwner);
    });
    it('non owner should not be able to change owner', async () => {
        const dataBefore = await nftCollection.getCollectionData();
        const newOwner = randomAddress(0);

        expect(dataBefore.owner).toEqualAddress(deployer.address);
        const res = await nftCollection.sendChangeOwner(blockchain.sender(newOwner), newOwner);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: newOwner,
            op: Op.change_owner,
            aborted: true,
            exitCode: Errors.invalid_sender
        });
    });
    it('should be able to re-init item on failure', async () => {
        const dataBefore = await nftCollection.getCollectionData();
        // Sending deploy message with insufficient TON forward.
        // In such condition item initialization is guaranteed to fail
        // Why are we not checning forward amount at collection level?

        const initialIdx = dataBefore.nextItemIndex;
        let initItem = await nftItemByIdx(initialIdx);

        let res = await nftCollection.sendDeployItem(deployer.getSender(), {
            owner: deployer.address,
            content: { type: 'offchain', uri: 'my_nft.json' },
        }, initialIdx, toNano('0.001'));

        expect(res.transactions).toHaveTransaction({
            on: initItem.address,
            from: nftCollection.address,
            deploy: true,
            aborted: true,
            exitCode: -14 // Not enough gas
        });

        let dataAfter = await nftCollection.getCollectionData();
        expect(dataAfter.nextItemIndex).toEqual(initialIdx + 1);
        let itemData  = await initItem.getNftData();
        expect(itemData.isInit).toBe(false);
        expect(itemData.owner).toBeNull();
        itemNotInitedState = blockchain.snapshot();

        //Now re-try with larger amount

        res = await nftCollection.sendDeployItem(deployer.getSender(), {
            owner: deployer.address,
            content: { type: 'offchain', uri: 'my_nft.json' },
        }, initialIdx, toNano('0.01'));

        expect(res.transactions).toHaveTransaction({
            on: initItem.address,
            from: nftCollection.address,
            value: toNano('0.01'),
            aborted: false
        });

        dataAfter = await nftCollection.getCollectionData();

        itemData  = await initItem.getNftData();
        expect(itemData.isInit).toBe(true);
        expect(itemData.owner).toEqualAddress(deployer.address);

        // Deploying lower than current index should not resolve in index increment
        expect(dataAfter.nextItemIndex).toEqual(initialIdx + 1);
    });
    it('should return joined content', async () => {
        const testContent = nftContentToCell({type: 'offchain', 'uri': 'my_nft.json'});
        const resContent = await nftCollection.getNftContent(1, testContent);
        expect(resContent).toEqualCell(beginCell()
                                            .storeUint(1, 8)
                                            .storeStringTail(commonContent)
                                            .storeRef(testContent)
                                          .endCell());
    });
    it('should return royalty parameters', async () => {
        const msgPrices = getMsgPrices(blockchain.config, 0);
        const msgValue  = toNano('0.05');
        const queryId   = getRandomInt(0, 100);

        const res = await nftCollection.sendGetRoyaltyParams(deployer.getSender(), msgValue, queryId);

        const getRoyaltyTx = findTransactionRequired(res.transactions, {
            on: nftCollection.address,
            from: deployer.address,
            op: Op.get_royalty_params,
            aborted: false,
            outMessagesCount: 1
        });

        const outMsg = getRoyaltyTx.outMessages.get(0)!;
        if(outMsg.info.type !== 'internal') {
            throw Error("No way!");
        }

        const fwdFee       = computeMessageForwardFees(msgPrices, outMsg);
        const computePhase = computedGeneric(getRoyaltyTx);

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: nftCollection.address,
            value: msgValue - fwdFee.fees.total - computePhase.gasFees, // Should return change
            body: beginCell()
                    .storeUint(Op.report_royalty_params, 32)
                    .storeUint(queryId, 64)
                    .storeUint(royaltyFactor, 16)
                    .storeUint(royaltyBase, 16)
                    .storeAddress(royaltyWallet.address)
                  .endCell()
        });

    });
    });
    describe('Item', () => {
    it('item owner should be able to transfer item', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();
        const testQueryId    = getRandomInt(42, 142);
        const res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'), testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            outMessagesCount: 2,
            aborted: false
        });

        expect(res.transactions).toHaveTransaction({
            on: dstAddr,
            from: deployerItem.address,
            value: forwardAmount,
            body: beginCell().storeUint(Op.ownership_assigned, 32)
                             .storeUint(testQueryId, 64)
                             .storeAddress(deployer.address)
                             .storeBit(true).storeRef(forwardPayload)
                  .endCell()
        });

        expect(res.transactions).toHaveTransaction({
            on: royaltyWallet.address,
            from: deployerItem.address,
            op: Op.excesses
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        const msgPrices = getMsgPrices(blockchain.config, 0);

        const inMsg = res.transactions[1].inMessage!;

        if(inMsg.info.type !== 'internal') {
            throw "No way!";
        }

        // Make sure that 3/2 approach is applicable
        expect(inMsg.info.forwardFee * 3n / 2n).toBeGreaterThanOrEqual(computeMessageForwardFees(msgPrices, inMsg).fees.total);
    });
    it('non-owner should not be able to transfer item', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        // Make sure transfer mode doesn't impact auth check
        for(let testVector of [
            {response: royaltyWallet.address, amount: forwardAmount, payload: forwardPayload},
            {response: royaltyWallet.address, amount: forwardAmount, payload: null},
            {response: royaltyWallet.address, amount: 0n, payload: null},
            {response: null, amount: forwardAmount, payload: forwardPayload},
            {response: null, amount: forwardAmount, payload: null},
            {response: null, amount: 0n, payload: null},
        ]) {

            const res = await deployerItem.sendTransfer(royaltyWallet.getSender(),
                                                        royaltyWallet.address,
                                                        testVector.response,
                                                        testVector.amount,
                                                        testVector.payload,
                                                        testVector.amount + toNano('1'));
            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: royaltyWallet.address,
                op: Op.transfer,
                aborted: true,
                exitCode: Errors.invalid_sender
            });
        }

    });

    it('transfer should work with minimal amount, and amount depends on number of outgoing messages', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();
        const testQueryId    = getRandomInt(42, 142);

        let smc = await blockchain.getContract(deployerItem.address);
        smc.balance = toNano('0.05');

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'), testQueryId);

        let dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        const transferTx = findTransactionRequired(res.transactions, {
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        const inMsg = transferTx.inMessage!;

        if(inMsg.info.type !== 'internal') {
            throw "No way!";
        }

        // ExpectedFee
        const expFee = inMsg.info.forwardFee * 3n / 2n;

        let minFee = forwardAmount + expFee * 2n;

        // Roll back and try again with value below minFee
        await blockchain.loadFrom(itemsDeployedState);

        smc = await blockchain.getContract(deployerItem.address);
        smc.balance = toNano('0.05');


        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee - 1n, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_gas
        });

        // Now with minimalFee but balance below storage value
        smc.balance = toNano('0.05') - (BigInt(getRandomInt(1, 4)) * toNano('0.01'));
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_gas
        });

        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee + (toNano('0.05') - smc.balance), testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        // Make sure forwardAmount particpates in fee calculation
        await blockchain.loadFrom(itemsDeployedState);
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount + 1n, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_gas
        });

        // Dropping outgoing messages should result in lowering minimal fee
        for(let testVector of [{refund: null, amount: forwardAmount}, {refund: dstAddr, amount: 0n}]) {
            await blockchain.loadFrom(itemsDeployedState);
            // Accepted minFee should be lowered by 1 expected forward fee
            res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, testVector.refund, testVector.amount, forwardPayload, minFee - expFee, testQueryId);

            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: deployer.address,
                op: Op.transfer,
                aborted: false,
                outMessagesCount: 1
            });

            dataAfter = await deployerItem.getNftData();
            expect(dataAfter.owner).toEqualAddress(dstAddr);
        }

        // console.log(res.transactions[1].description);
        expect(smc.balance).toBeGreaterThanOrEqual(toNano('0.05')); // Min storage should be left on contract


        // Now try minimal fee
        await blockchain.loadFrom(itemsDeployedState);
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        // console.log(res.transactions[1].description);
        expect(smc.balance).toBeGreaterThanOrEqual(toNano('0.05')); // Min storage should be left on contract
    });

    it('owner should be able to transfer item without notification', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = 0n; // Forward amount is zero, payload should be ignored
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'));

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 1
        });

        expect(res.transactions).toHaveTransaction({
            on: royaltyWallet.address,
            from: deployerItem.address,
            op: Op.excesses
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);
    });
    it('owner should be able to attach data directly into ownership_assigned body', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = 1n;
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload.asSlice(), forwardAmount + toNano('1'), 42n);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            outMessagesCount: 2,
            aborted: false
        });

        expect(res.transactions).toHaveTransaction({
            on: dstAddr,
            from: deployerItem.address,
            value: forwardAmount,
            body: beginCell().storeUint(Op.ownership_assigned, 32)
                             .storeUint(42n, 64)
                             .storeAddress(deployer.address)
                             .storeBit(false)
                             .storeSlice(forwardPayload.asSlice())
                  .endCell()
        });
    });

    it('should validate Either forward_payload', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = 1n;
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        const transferMsg = NftItem.transferMessage(dstAddr, deployer.address, forwardAmount, forwardPayload);
        // Last indicator bit cut
        const truncated   = beginCell().storeBits(transferMsg.beginParse().loadBits(transferMsg.bits.length - 1)).endCell();
        // Indicator bit set to true, but ref is absent
        const noRef       = new Cell({bits: transferMsg.bits, refs: []});

        for(let testPayload of [truncated, noRef]) {
            const res = await deployer.send({
                to: deployerItem.address,
                body: testPayload,
                value: toNano('1')
            });
            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: deployer.address,
                op: Op.transfer,
                aborted: true,
                exitCode: Errors.invalid_payload
            });
        }
    });
    it('owner should be able to transfer item without excess and forward payload', async () => {
        await blockchain.loadFrom(itemsDeployedState);

        const deployerItem = await nftItemByIdx(0);
        const dstAddr = randomAddress(0);

        const forwardAmount = 0n; // Forward amount is zero, payload should be ignored

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, null, forwardAmount);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 0
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);
    });
    it('should return static data', async () => {
        await blockchain.loadFrom(itemsDeployedState);
        const msgPrices = getMsgPrices(blockchain.config, 0);
        const colData = await nftCollection.getCollectionData();
        const lastIdx = colData.nextItemIndex;

        expect(lastIdx).toBeGreaterThan(0);

        const testIdx = getRandomInt(0, lastIdx - 1);

        const testItem = await nftItemByIdx(testIdx);

        const msgValue = toNano('0.05');
        const queryId  = getRandomInt(0, 100);
        const res = await testItem.sendGetStaticData(deployer.getSender(), msgValue, queryId);

        const getDataTx = findTransactionRequired(res.transactions, {
            on: testItem.address,
            from: deployer.address,
            op: Op.get_static_data,
            aborted: false,
            outMessagesCount: 1
        });

        const outMsg = getDataTx.outMessages.get(0)!;
        if(outMsg.info.type !== 'internal') {
            throw Error("No way!");
        }
        const fwdFee = computeMessageForwardFees(msgPrices, outMsg);

        const computePhase = computedGeneric(getDataTx);
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: testItem.address,
            value: msgValue - fwdFee.fees.total - computePhase.gasFees,
            body: beginCell()
                    .storeUint(Op.report_static_data, 32)
                    .storeUint(queryId, 64)
                    .storeUint(testIdx, 256)
                    .storeAddress(nftCollection.address)
                  .endCell()
        });
    });
    });
});

