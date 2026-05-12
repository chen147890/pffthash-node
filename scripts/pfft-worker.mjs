import { parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";

const workerId = workerData.workerId;
const batchSize = Math.max(256, Number(workerData.batchSize || 4096));
const reportIntervalMs = Math.max(250, Number(workerData.reportIntervalMs || 1000));
const challengeBytes = hexToBytes(workerData.challenge, 32);
const targetBytes = uint256ToBytes(BigInt(workerData.target));
const input = new Uint8Array(64);
const nonceBytes = randomBytes(32);
input.set(challengeBytes, 0);

let stopped = false;
let attempts = 0n;
let lastReportAt = Date.now();
let latestNonce = null;

parentPort.on("message", (message) => {
  if (message?.type === "stop") stopped = true;
});

function randomUint256() {
  return randomBytes(32);
}

function nextNonce() {
  for (let index = 31; index >= 0; index -= 1) {
    nonceBytes[index] = (nonceBytes[index] + 1) & 255;
    if (nonceBytes[index] !== 0) break;
  }
  return nonceBytes;
}

function hexToBytes(value, expectedLength) {
  const hex = String(value).replace(/^0x/, "");
  if (hex.length !== expectedLength * 2) {
    throw new Error(`expected ${expectedLength} bytes, got ${hex.length / 2}`);
  }
  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function uint256ToBytes(value) {
  const bytes = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return bytes;
}

function bytesToHex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function bytesToBigInt(bytes) {
  return BigInt(bytesToHex(bytes));
}

function isLessThanOrEqual(a, b) {
  for (let index = 0; index < 32; index += 1) {
    if (a[index] < b[index]) return true;
    if (a[index] > b[index]) return false;
  }
  return true;
}

function report(type = "progress") {
  parentPort.postMessage({
    type,
    workerId,
    attempts: attempts.toString(),
    latestNonce: latestNonce ? bytesToBigInt(latestNonce).toString() : null,
    elapsedMs: Date.now() - workerData.startedAt
  });
}

try {
  while (!stopped) {
    for (let index = 0; index < batchSize; index += 1) {
      const nonce = workerData.nonceMode === "random" ? randomUint256() : nextNonce();
      latestNonce = nonce;
      attempts += 1n;
      input.set(nonce, 32);

      const hash = keccak_256(input);
      if (isLessThanOrEqual(hash, targetBytes)) {
        parentPort.postMessage({
          type: "solved",
          workerId,
          attempts: attempts.toString(),
          powNonce: bytesToBigInt(nonce).toString(),
          hash: bytesToHex(hash),
          elapsedMs: Date.now() - workerData.startedAt
        });
        stopped = true;
        break;
      }
    }

    const now = Date.now();
    if (!stopped && now - lastReportAt >= reportIntervalMs) {
      report();
      lastReportAt = now;
    }
  }

  if (stopped) report("stopped");
} catch (error) {
  parentPort.postMessage({
    type: "error",
    workerId,
    message: error?.message || String(error)
  });
}
