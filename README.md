# TON NFT Contract

Reference implementation of NFT (non-fungible token) smart contract for TON

`nft-collection.fc` - basic implementation of immutable NFT collection with royalty.

`nft-collection-editable.fc` - basic implementation of the NFT collection with royalty in which the author can change the content and royalty params.

It is preferable to use an editable collection in case if you decide to change content hosting in the future (for example, to TON Storage).

`nft-item.fc` - basic implementation of immutable NFT item.

Also repo contains an example of a simple marketplace smart contract `nft-marketplace` and a smart contract for selling NFT for a fixed price for Toncoins `nft-sale`.

In a real product, marketplace and sale smart contracts are likely to be more sophisticated.

# Compile

Compiled contracts are in `build/` folders. Compiled by [func-0.3.0](https://github.com/ton-blockchain/ton/releases/tag/func-0.3.0).