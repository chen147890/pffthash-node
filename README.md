# pffthash-node

Standalone miner for [pffthash.com](https://pffthash.com/).

It reads the Ethereum mainnet PFFT contract, solves:

```text
keccak256(abi.encodePacked(currentPowChallenge(wallet), uint256 nonce)) <= POW_TARGET
```

Then submits:

```text
freeMint(powNonce)
```

## Setup

```sh
cd /Users/laixingyun/Desktop/pffthash-node
npm install
cp .env.example .env
```

Fill `.env`:

```sh
EVM_PRIVATE_KEY=your_dedicated_mint_wallet_private_key
```

## Run

Check RPC, wallet, balance, and current difficulty:

```sh
npm run preflight
```

Start mining:

```sh
npm start
```

## Notes

- Use a dedicated wallet, not your main wallet.
- Keep a little ETH in the wallet for gas.
- `PFFT_THREADS=auto` uses all logical CPU cores on Mac or Ubuntu.
- `PFFT_MINT_COUNT=1` exits after one confirmed mint.
- `PFFT_MINT_COUNT=0` keeps mining in a loop.
- `PFFT_CONTINUE_ON_TX_ERROR=1` keeps the miner running after reverted or failed mint transactions.
