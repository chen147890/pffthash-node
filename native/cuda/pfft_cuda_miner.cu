#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <vector>

struct DeviceResult {
  int found;
  unsigned char nonce[32];
  unsigned char hash[32];
  unsigned long long attempts;
};

__constant__ unsigned long long KECCAKF_RNDC[24] = {
  0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
  0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
  0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
  0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
  0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
  0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
  0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
  0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

__device__ __forceinline__ unsigned long long rotl64(unsigned long long x, int s) {
  return (x << s) | (x >> (64 - s));
}

__device__ void keccak_f1600(unsigned long long st[25]) {
  const int piln[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};
  const int rotc[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};

  for (int round = 0; round < 24; round++) {
    unsigned long long bc[5];
    for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (int i = 0; i < 5; i++) {
      unsigned long long t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
    }

    unsigned long long t = st[1];
    for (int i = 0; i < 24; i++) {
      int j = piln[i];
      unsigned long long tmp = st[j];
      st[j] = rotl64(t, rotc[i]);
      t = tmp;
    }

    for (int j = 0; j < 25; j += 5) {
      unsigned long long row[5];
      for (int i = 0; i < 5; i++) row[i] = st[j + i];
      for (int i = 0; i < 5; i++) st[j + i] = row[i] ^ ((~row[(i + 1) % 5]) & row[(i + 2) % 5]);
    }

    st[0] ^= KECCAKF_RNDC[round];
  }
}

__device__ __forceinline__ unsigned long long load64_le(const unsigned char* p) {
  unsigned long long value = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) value |= ((unsigned long long)p[i]) << (8 * i);
  return value;
}

__device__ __forceinline__ void store64_be(unsigned long long value, unsigned char* p) {
  #pragma unroll
  for (int i = 0; i < 8; i++) p[7 - i] = (unsigned char)((value >> (8 * i)) & 0xff);
}

__device__ __forceinline__ int hash_le_target(const unsigned char* hash, const unsigned char* target) {
  #pragma unroll
  for (int i = 0; i < 32; i++) {
    if (hash[i] < target[i]) return 1;
    if (hash[i] > target[i]) return 0;
  }
  return 1;
}

__global__ void mine_kernel(
  const unsigned char* challenge,
  const unsigned char* target,
  unsigned long long prefix_hi,
  unsigned long long prefix_lo,
  unsigned long long start,
  unsigned long long stride,
  unsigned long long iterations,
  DeviceResult* result
) {
  unsigned long long tid = blockIdx.x * blockDim.x + threadIdx.x;
  unsigned long long nonce_low = start + tid;

  for (unsigned long long iter = 0; iter < iterations; iter++, nonce_low += stride) {
    if (result->found) return;

    unsigned char input[136];
    #pragma unroll
    for (int i = 0; i < 136; i++) input[i] = 0;
    #pragma unroll
    for (int i = 0; i < 32; i++) input[i] = challenge[i];
    store64_be(prefix_hi, input + 32);
    store64_be(prefix_lo, input + 40);
    store64_be(0ULL, input + 48);
    store64_be(nonce_low, input + 56);
    input[64] = 0x01;
    input[135] = 0x80;

    unsigned long long st[25];
    #pragma unroll
    for (int i = 0; i < 25; i++) st[i] = 0;
    #pragma unroll
    for (int i = 0; i < 17; i++) st[i] ^= load64_le(input + i * 8);
    keccak_f1600(st);

    unsigned char hash[32];
    #pragma unroll
    for (int lane = 0; lane < 4; lane++) {
      unsigned long long v = st[lane];
      #pragma unroll
      for (int b = 0; b < 8; b++) hash[lane * 8 + b] = (unsigned char)((v >> (8 * b)) & 0xff);
    }

    if (hash_le_target(hash, target) && atomicCAS(&(result->found), 0, 1) == 0) {
      #pragma unroll
      for (int i = 0; i < 16; i++) result->nonce[i] = (i < 8) ? input[32 + i] : input[32 + i];
      #pragma unroll
      for (int i = 16; i < 32; i++) result->nonce[i] = input[32 + i];
      #pragma unroll
      for (int i = 0; i < 32; i++) result->hash[i] = hash[i];
      result->attempts = iter * stride + tid + 1ULL;
      return;
    }
  }
}

static int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool parse_hex32(const std::string& raw, std::array<unsigned char, 32>& out) {
  std::string hex = raw.rfind("0x", 0) == 0 ? raw.substr(2) : raw;
  if (hex.size() > 64) return false;
  if (hex.size() < 64) hex = std::string(64 - hex.size(), '0') + hex;
  for (int i = 0; i < 32; i++) {
    int hi = hex_value(hex[i * 2]);
    int lo = hex_value(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (unsigned char)((hi << 4) | lo);
  }
  return true;
}

static std::string bytes_hex(const unsigned char* bytes, int len) {
  std::ostringstream out;
  out << "0x" << std::hex << std::setfill('0');
  for (int i = 0; i < len; i++) out << std::setw(2) << (int)bytes[i];
  return out.str();
}

static std::string bytes_decimal(const unsigned char* bytes, int len) {
  std::vector<unsigned char> value(bytes, bytes + len);
  std::string digits;
  while (true) {
    int carry = 0;
    bool any = false;
    for (int i = 0; i < len; i++) {
      int current = carry * 256 + value[i];
      value[i] = (unsigned char)(current / 10);
      carry = current % 10;
      if (value[i]) any = true;
    }
    digits.push_back((char)('0' + carry));
    if (!any) break;
  }
  std::reverse(digits.begin(), digits.end());
  return digits;
}

static std::vector<int> parse_devices(const std::string& value) {
  int count = 0;
  cudaGetDeviceCount(&count);
  std::vector<int> devices;
  if (value == "auto" || value.empty()) {
    for (int i = 0; i < count; i++) devices.push_back(i);
    return devices;
  }
  std::stringstream ss(value);
  std::string item;
  while (std::getline(ss, item, ',')) {
    int id = std::atoi(item.c_str());
    if (id >= 0 && id < count) devices.push_back(id);
  }
  return devices;
}

int main(int argc, char** argv) {
  std::string challenge_arg;
  std::string target_arg;
  std::string device_arg = "auto";
  int blocks = 4096;
  int threads = 256;
  unsigned long long iterations = 64;
  int report_ms = 5000;

  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::cerr << "Missing value for " << arg << "\n";
        std::exit(2);
      }
      return argv[++i];
    };
    if (arg == "--challenge") challenge_arg = next();
    else if (arg == "--target") target_arg = next();
    else if (arg == "--devices") device_arg = next();
    else if (arg == "--blocks") blocks = std::atoi(next().c_str());
    else if (arg == "--threads") threads = std::atoi(next().c_str());
    else if (arg == "--iterations") iterations = std::strtoull(next().c_str(), nullptr, 10);
    else if (arg == "--report-ms") report_ms = std::atoi(next().c_str());
    else if (arg == "--list-devices") {
      int count = 0;
      cudaGetDeviceCount(&count);
      std::cout << "{\"type\":\"devices\",\"count\":" << count << ",\"devices\":[";
      for (int d = 0; d < count; d++) {
        cudaDeviceProp prop{};
        cudaGetDeviceProperties(&prop, d);
        if (d) std::cout << ",";
        std::cout << "{\"id\":" << d << ",\"name\":\"" << prop.name << "\",\"memoryMb\":" << (prop.totalGlobalMem / 1024 / 1024) << "}";
      }
      std::cout << "]}" << std::endl;
      return 0;
    }
  }

  std::array<unsigned char, 32> challenge{};
  std::array<unsigned char, 32> target{};
  if (!parse_hex32(challenge_arg, challenge) || !parse_hex32(target_arg, target)) {
    std::cerr << "Usage: pfft-cuda-miner --challenge 0x... --target 0x... [--devices auto|0,1]\n";
    return 2;
  }

  std::vector<int> devices = parse_devices(device_arg);
  if (devices.empty()) {
    std::cerr << "No CUDA devices available.\n";
    return 1;
  }

  std::random_device rd;
  std::mt19937_64 rng(((unsigned long long)rd() << 32) ^ rd());
  std::vector<unsigned char*> d_challenge(devices.size());
  std::vector<unsigned char*> d_target(devices.size());
  std::vector<DeviceResult*> d_result(devices.size());
  std::vector<DeviceResult> h_result(devices.size());
  std::vector<unsigned long long> prefix_hi(devices.size());
  std::vector<unsigned long long> prefix_lo(devices.size());

  for (size_t i = 0; i < devices.size(); i++) {
    cudaSetDevice(devices[i]);
    cudaMalloc(&d_challenge[i], 32);
    cudaMalloc(&d_target[i], 32);
    cudaMalloc(&d_result[i], sizeof(DeviceResult));
    cudaMemcpy(d_challenge[i], challenge.data(), 32, cudaMemcpyHostToDevice);
    cudaMemcpy(d_target[i], target.data(), 32, cudaMemcpyHostToDevice);
    cudaMemset(d_result[i], 0, sizeof(DeviceResult));
    prefix_hi[i] = rng();
    prefix_lo[i] = (((unsigned long long)devices[i]) << 56) ^ rng();
  }

  const unsigned long long per_launch = (unsigned long long)blocks * (unsigned long long)threads * iterations;
  std::vector<unsigned long long> starts(devices.size(), 0);
  std::vector<unsigned long long> attempts(devices.size(), 0);
  auto started = std::chrono::steady_clock::now();
  auto last_report = started;

  while (true) {
    for (size_t i = 0; i < devices.size(); i++) {
      cudaSetDevice(devices[i]);
      mine_kernel<<<blocks, threads>>>(
        d_challenge[i],
        d_target[i],
        prefix_hi[i],
        prefix_lo[i],
        starts[i],
        (unsigned long long)blocks * (unsigned long long)threads,
        iterations,
        d_result[i]
      );
    }

    for (size_t i = 0; i < devices.size(); i++) {
      cudaSetDevice(devices[i]);
      cudaDeviceSynchronize();
      starts[i] += per_launch;
      attempts[i] += per_launch;
      cudaMemcpy(&h_result[i], d_result[i], sizeof(DeviceResult), cudaMemcpyDeviceToHost);
      if (h_result[i].found) {
        auto now = std::chrono::steady_clock::now();
        double elapsed_ms = std::chrono::duration<double, std::milli>(now - started).count();
        std::cout << "{\"type\":\"solved\",\"engine\":\"cuda\",\"device\":" << devices[i]
          << ",\"powNonce\":\"" << bytes_decimal(h_result[i].nonce, 32)
          << "\",\"hash\":\"" << bytes_hex(h_result[i].hash, 32)
          << "\",\"attempts\":\"" << (attempts[i] - per_launch + h_result[i].attempts)
          << "\",\"elapsedMs\":" << (unsigned long long)elapsed_ms << "}" << std::endl;
        return 0;
      }
    }

    auto now = std::chrono::steady_clock::now();
    double since_report = std::chrono::duration<double, std::milli>(now - last_report).count();
    if (since_report >= report_ms) {
      double elapsed_ms = std::chrono::duration<double, std::milli>(now - started).count();
      unsigned long long total = 0;
      for (auto value : attempts) total += value;
      double rate = elapsed_ms > 0 ? (double)total / elapsed_ms * 1000.0 : 0.0;
      std::cout << "{\"type\":\"progress\",\"engine\":\"cuda\",\"devices\":" << devices.size()
        << ",\"attempts\":\"" << total << "\",\"hashrate\":" << rate
        << ",\"elapsedMs\":" << (unsigned long long)elapsed_ms << "}" << std::endl;
      last_report = now;
    }
  }
}
