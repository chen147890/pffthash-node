# pffthash-node

Standalone CPU + CUDA miner for [pffthash.com](https://pffthash.com/).

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

## CUDA

On an NVIDIA GPU server, compile the CUDA miner once:

```sh
npm run setup
```

Then keep the normal command:

```sh
npm start
```

The default `PFFT_MINER_MODE=auto` uses CUDA when `runtime/bin/pfft-cuda-miner` exists and also keeps CPU workers running. With two GPUs, leave:

```sh
PFFT_CUDA_DEVICES=auto
```

To force CUDA only:

```sh
PFFT_MINER_MODE=cuda
```

To force CPU only:

```sh
PFFT_MINER_MODE=cpu
```

## Notes

- Use a dedicated wallet, not your main wallet.
- Keep a little ETH in the wallet for gas.
- `PFFT_THREADS=auto` uses all logical CPU cores on Mac or Ubuntu.
- `PFFT_MINER_MODE=auto` uses CUDA + CPU when the CUDA miner is compiled.
- `PFFT_CUDA_DEVICES=auto` uses all visible NVIDIA GPUs.
- `PFFT_MINT_COUNT=1` exits after one confirmed mint.
- `PFFT_MINT_COUNT=0` keeps mining in a loop.
- `PFFT_CONTINUE_ON_TX_ERROR=1` keeps the miner running after reverted or failed mint transactions.
