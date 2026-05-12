import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTRACT_ADDRESS = "0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB";
const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const ABI = [
  "function currentPowChallenge(address account) view returns (bytes32)",
  "function POW_TARGET() view returns (uint256)",
  "function POW_DIFFICULTY_BITS() view returns (uint256)",
  "function currentPowStage() view returns (uint256)",
  "function currentPowHexZeros() view returns (uint256)",
  "function getInfo() view returns (uint256 totalMinted, uint256 remainingSupply, uint256 decayRate, uint256 nextMintAmount)",
  "function minted(address account) view returns (uint256)",
  "function freeMint(uint256 powNonce)"
];

function loadEnvFile(root = ROOT) {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of ["api-key", "apikey", "key", "token"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return String(rawUrl).replace(/((?:api-key|apikey|key|token)=)[^&\s]+/gi, "$1REDACTED");
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function formatHashrate(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 H/s";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MH/s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} kH/s`;
  return `${value.toFixed(2)} H/s`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function expectedAttempts(target) {
  if (target <= 0n) return null;
  const space = 1n << 256n;
  const expected = space / (target + 1n);
  return Number(expected > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : expected);
}

function uint256Hex(value) {
  const hex = BigInt(value).toString(16).padStart(64, "0");
  return `0x${hex}`;
}

function shouldUseCuda(config) {
  const mode = config.minerMode.toLowerCase();
  if (mode === "cpu") return false;
  if (["cuda", "gpu", "hybrid"].includes(mode)) return true;
  return existsSync(config.cudaBin);
}

function shouldUseCpu(config) {
  const mode = config.minerMode.toLowerCase();
  if (mode === "cuda" || mode === "gpu") return false;
  return config.threads > 0;
}

function pfftConfig() {
  const logicalCores = cpus().length || 1;
  const threadsRaw = process.env.PFFT_THREADS || "auto";
  const threads = threadsRaw === "auto"
    ? logicalCores
    : Math.max(1, Math.floor(Number(threadsRaw) || logicalCores));
  return {
    rpcUrl: process.env.ETH_RPC_URL || process.env.PFFT_RPC_URL || DEFAULT_RPC,
    privateKey: process.env.EVM_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY || "",
    threads,
    batchSize: numberFromEnv("PFFT_BATCH_SIZE", 4096),
    minerMode: process.env.PFFT_MINER_MODE || "auto",
    cudaBin: join(ROOT, "runtime/bin/pfft-cuda-miner"),
    cudaDevices: process.env.PFFT_CUDA_DEVICES || "auto",
    cudaBlocks: numberFromEnv("PFFT_CUDA_BLOCKS", 4096),
    cudaThreads: numberFromEnv("PFFT_CUDA_THREADS", 256),
    cudaIterations: numberFromEnv("PFFT_CUDA_ITERATIONS", 64),
    nonceMode: process.env.PFFT_NONCE_MODE === "random" ? "random" : "sequential",
    reportIntervalMs: numberFromEnv("PFFT_REPORT_INTERVAL_MS", 5000),
    minEthBalance: Number(process.env.PFFT_MIN_ETH_BALANCE || "0.003"),
    autoSubmit: boolFromEnv("PFFT_AUTO_SUBMIT", true),
    continueOnTxError: boolFromEnv("PFFT_CONTINUE_ON_TX_ERROR", true),
    errorBackoffMs: numberFromEnv("PFFT_ERROR_BACKOFF_MS", 5000),
    mintCount: Math.max(0, Math.floor(Number(process.env.PFFT_MINT_COUNT || "1"))),
    contractAddress: process.env.PFFT_CONTRACT || CONTRACT_ADDRESS
  };
}

async function optionalCall(contract, name, fallback = null) {
  try {
    return await contract[name]();
  } catch {
    return fallback;
  }
}

async function preflight(config, provider, wallet, contract) {
  const [network, balance, info, minted, target, bits, stage, zeros, challenge] = await Promise.all([
    provider.getNetwork(),
    provider.getBalance(wallet.address),
    contract.getInfo(),
    contract.minted(wallet.address),
    contract.POW_TARGET(),
    optionalCall(contract, "POW_DIFFICULTY_BITS"),
    optionalCall(contract, "currentPowStage"),
    optionalCall(contract, "currentPowHexZeros"),
    contract.currentPowChallenge(wallet.address)
  ]);

  const ethBalance = Number(formatEther(balance));
  console.log("PFFT preflight");
  console.log(`  RPC:       ${redactUrl(config.rpcUrl)}`);
  console.log(`  Network:   ${network.name || "unknown"} (${network.chainId})`);
  console.log(`  Contract:  ${config.contractAddress}`);
  console.log(`  Wallet:    ${wallet.address}`);
  console.log(`  Balance:   ${ethBalance.toFixed(6)} ETH`);
  console.log(`  Minted:    ${formatUnits(minted, 18)} PFFT`);
  console.log(`  Quote:     ${formatUnits(info.nextMintAmount, 18)} PFFT`);
  console.log(`  Stage:     ${stage === null ? "-" : `${Number(stage) + 1}/5`}`);
  console.log(`  Target:    ${target.toString()}`);
  console.log(`  Bits:      ${bits === null ? "-" : Number(bits)}`);
  console.log(`  Hex zeros: ${zeros === null ? "-" : Number(zeros)}`);
  console.log(`  Challenge: ${challenge}`);
  console.log(`  Mode:      ${config.minerMode}`);
  console.log(`  CPU:       ${shouldUseCpu(config) ? `${config.threads} threads` : "off"}`);
  console.log(`  CUDA:      ${shouldUseCuda(config) ? `${config.cudaDevices} devices` : "off"}`);
  console.log(`  Nonces:    ${config.nonceMode}`);
  console.log(`  Submit:    ${config.autoSubmit ? "yes" : "no"}`);

  if (network.chainId !== 1n) throw new Error(`Wrong chain ${network.chainId}; PFFT is Ethereum mainnet.`);
  if (ethBalance < config.minEthBalance) {
    throw new Error(`ETH balance ${ethBalance.toFixed(6)} is below PFFT_MIN_ETH_BALANCE=${config.minEthBalance}.`);
  }

  return { challenge, target, expected: expectedAttempts(target) };
}

async function mineOnce(config, challenge, target) {
  const workerPath = fileURLToPath(new URL("./pfft-worker.mjs", import.meta.url));
  const startedAt = Date.now();
  const workers = [];
  let cudaProcess = null;
  const progress = new Map();
  let settled = false;

  return await new Promise((resolve, reject) => {
    const stopAll = () => {
      for (const worker of workers) worker.postMessage({ type: "stop" });
      if (cudaProcess && !cudaProcess.killed) cudaProcess.kill("SIGTERM");
      setTimeout(() => {
        for (const worker of workers) worker.terminate().catch(() => {});
        if (cudaProcess && !cudaProcess.killed) cudaProcess.kill("SIGKILL");
      }, 250);
    };

    const timer = setInterval(() => {
      const attempts = [...progress.values()].reduce((sum, item) => sum + item.attempts, 0n);
      const elapsedMs = Date.now() - startedAt;
      const hashrate = elapsedMs > 0 ? Number(attempts) / elapsedMs * 1000 : 0;
      console.log(`[pfft] attempts=${attempts.toString()} rate=${formatHashrate(hashrate)} elapsed=${formatDuration(elapsedMs)}`);
    }, config.reportIntervalMs);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      stopAll();
      callback();
    };

    if (shouldUseCuda(config)) {
      if (!existsSync(config.cudaBin)) {
        const message = `CUDA miner is missing: ${config.cudaBin}. Run npm run setup on the GPU server.`;
        const mode = config.minerMode.toLowerCase();
        if (mode === "cuda" || mode === "gpu") {
          finish(() => reject(new Error(message)));
          return;
        }
        console.log(`[pfft] ${message} Falling back to CPU.`);
      } else {
        const args = [
          "--challenge", challenge,
          "--target", uint256Hex(target),
          "--devices", config.cudaDevices,
          "--blocks", String(config.cudaBlocks),
          "--threads", String(config.cudaThreads),
          "--iterations", String(config.cudaIterations),
          "--report-ms", String(config.reportIntervalMs)
        ];
        cudaProcess = spawn(config.cudaBin, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
        let buffer = "";
        cudaProcess.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line) continue;
            try {
              const message = JSON.parse(line);
              if (message.type === "progress") {
                progress.set("cuda", { attempts: BigInt(message.attempts || "0") });
                continue;
              }
              if (message.type === "solved") {
                progress.set("cuda", { attempts: BigInt(message.attempts || "0") });
                const attempts = [...progress.values()].reduce((sum, item) => sum + item.attempts, 0n);
                const elapsedMs = Date.now() - startedAt;
                const hashrate = elapsedMs > 0 ? Number(attempts) / elapsedMs * 1000 : 0;
                finish(() => resolve({
                  powNonce: BigInt(message.powNonce),
                  hash: message.hash,
                  attempts,
                  elapsedMs,
                  hashrate,
                  engine: `cuda:${message.device}`
                }));
              }
            } catch {
              console.log(`[cuda] ${line}`);
            }
          }
        });
        cudaProcess.stderr.on("data", (chunk) => {
          for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) console.error(`[cuda] ${line}`);
        });
        cudaProcess.on("exit", (code, signal) => {
          if (settled || signal) return;
          const mode = config.minerMode.toLowerCase();
          if ((mode === "cuda" || mode === "gpu") && code !== 0) {
            finish(() => reject(new Error(`CUDA miner exited with code ${code}`)));
          }
        });
      }
    }

    if (!shouldUseCpu(config)) return;

    for (let workerId = 0; workerId < config.threads; workerId += 1) {
      const worker = new Worker(workerPath, {
        workerData: {
          workerId,
          challenge,
          target: target.toString(),
          batchSize: config.batchSize,
          nonceMode: config.nonceMode,
          reportIntervalMs: Math.max(1000, Math.floor(config.reportIntervalMs / 2)),
          startedAt
        }
      });
      workers.push(worker);

      worker.on("message", (message) => {
        if (message?.type === "progress" || message?.type === "stopped") {
          progress.set(message.workerId, { attempts: BigInt(message.attempts || "0") });
          return;
        }
        if (message?.type === "solved") {
          progress.set(message.workerId, { attempts: BigInt(message.attempts || "0") });
          const attempts = [...progress.values()].reduce((sum, item) => sum + item.attempts, 0n);
          const elapsedMs = Date.now() - startedAt;
          const hashrate = elapsedMs > 0 ? Number(attempts) / elapsedMs * 1000 : 0;
          finish(() => resolve({
            powNonce: BigInt(message.powNonce),
            hash: message.hash,
            attempts,
            elapsedMs,
            hashrate,
            engine: `cpu:${message.workerId}`
          }));
          return;
        }
        if (message?.type === "error") {
          finish(() => reject(new Error(`Worker ${message.workerId} failed: ${message.message}`)));
        }
      });
      worker.on("error", (error) => finish(() => reject(error)));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`Worker exited with code ${code}`)));
      });
    }
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error?.shortMessage || error?.reason || error?.message || String(error);
}

async function submitSolution(contract, solution) {
  console.log("[pfft] checking freeMint(powNonce)...");
  await contract.freeMint.staticCall(solution.powNonce);
  console.log("[pfft] sending freeMint(powNonce)...");
  const tx = await contract.freeMint(solution.powNonce);
  console.log(`[pfft] tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`);
  console.log(`[pfft] confirmed in block ${receipt.blockNumber}: ${tx.hash}`);
  return receipt;
}

async function main() {
  loadEnvFile();
  const config = pfftConfig();
  if (process.env.PFFT_PREFLIGHT_ONLY === "1") config.autoSubmit = false;
  if (!config.privateKey) {
    throw new Error("Missing EVM_PRIVATE_KEY in .env. Use a dedicated mint wallet with a small ETH balance.");
  }

  const provider = new JsonRpcProvider(config.rpcUrl, 1, { staticNetwork: true });
  const wallet = new Wallet(config.privateKey, provider);
  const contract = new Contract(config.contractAddress, ABI, wallet);
  const targetMints = config.mintCount === 0 ? Number.POSITIVE_INFINITY : config.mintCount;
  let completedMints = 0;
  let attempts = 0;

  while (completedMints < targetMints) {
    attempts += 1;
    console.log("");
    console.log(`PFFT mining attempt ${attempts}${config.mintCount === 0 ? " (continuous)" : `, confirmed ${completedMints}/${config.mintCount}`}`);

    try {
      const { challenge, target, expected } = await preflight(config, provider, wallet, contract);
      if (expected) console.log(`  Expected:  ~${Math.round(expected).toLocaleString()} tries`);
      if (process.env.PFFT_PREFLIGHT_ONLY === "1") return;

      const solution = await mineOnce(config, challenge, target);
      console.log(`[pfft] solved nonce=${solution.powNonce.toString()} hash=${solution.hash}`);
      console.log(`[pfft] engine=${solution.engine || "unknown"} attempts=${solution.attempts.toString()} rate=${formatHashrate(solution.hashrate)} elapsed=${formatDuration(solution.elapsedMs)}`);

      if (!config.autoSubmit) {
        console.log("[pfft] PFFT_AUTO_SUBMIT=0, not sending transaction.");
        continue;
      }

      await submitSolution(contract, solution);
      completedMints += 1;
    } catch (error) {
      console.error(`[pfft] attempt ${attempts} failed: ${errorMessage(error)}`);
      if (!config.continueOnTxError) throw error;
      console.log(`[pfft] continuing in ${formatDuration(config.errorBackoffMs)}. A revert can happen if the solved nonce became stale or the contract rejected the mint.`);
      await sleep(config.errorBackoffMs);
    }
  }
}

main().catch((error) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exit(1);
});
